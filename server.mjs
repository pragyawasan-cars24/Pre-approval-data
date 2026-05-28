import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 4173);
const HUBSPOT_BASE_URL = "https://api.hubapi.com";
const CACHE_TTL_MS = 5 * 60 * 1000;
const BATCH_SIZE = 100;
const MAX_PARALLEL = 6;
const DEFAULT_START_DATE = "2026-05-18";

const PROPERTY_MAP = {
  contact: {
    email: "email",
    phone: "phone",
    preApprovalType: "pre_approval_type",
    preApprovalVersion: "pre_approval_version",
    paymentMode: "payment_mode",
    preApprovalStartDate: "pre_approval_start_date",
    createdDate: "createdate",
    financeStatus: "finance_status",
    userFinanceCohort: "user_finance_cohort"
  },
  deal: {
    dealName: "dealname",
    preApprovalType: "pre_approval_type",
    preApprovalVersion: "pre_approval_version",
    paymentMode: "payment_mode",
    paymentMethod: "payment_method",
    bookingConfirmDate: "booking_confirm_date",
    createdDate: "createdate",
    preApprovalStartDate: "customer_pre_approval_start_date",
    customerFinanceStatus: "customer_finance_status",
    userCohort: "user_cohort"
  }
};

let cachedDashboard = null;
let cachedAt = 0;

function readHubspotToken() {
  if (process.env.HUBSPOT_TOKEN) {
    return process.env.HUBSPOT_TOKEN;
  }

  const fallbackEnv = "/Users/a38651/Documents/Codex/2026-05-26/okay-i-need-a-view-now/.env";
  if (!fs.existsSync(fallbackEnv)) {
    throw new Error("Missing HUBSPOT_TOKEN. Set it in the environment or keep the earlier local .env file.");
  }

  const contents = fs.readFileSync(fallbackEnv, "utf8");
  const match = contents.match(/^HUBSPOT_TOKEN=(.+)$/m);
  if (!match) {
    throw new Error("HUBSPOT_TOKEN was not found in the fallback .env file.");
  }

  return match[1].trim();
}

async function hubspotFetch(pathname, init = {}) {
  const response = await fetch(`${HUBSPOT_BASE_URL}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${readHubspotToken()}`,
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`HubSpot API error ${response.status}: ${json.message || "Unknown error"}`);
  }
  return json;
}

async function searchAllContacts() {
  const results = [];
  let after;
  const startTimestamp = String(Date.parse(`${DEFAULT_START_DATE}T00:00:00Z`));

  do {
    const payload = {
      filterGroups: [
        {
          filters: [
            {
              propertyName: PROPERTY_MAP.contact.preApprovalType,
              operator: "HAS_PROPERTY"
            },
            {
              propertyName: PROPERTY_MAP.contact.preApprovalStartDate,
              operator: "GTE",
              value: startTimestamp
            }
          ]
        }
      ],
      properties: Object.values(PROPERTY_MAP.contact),
      limit: 100,
      after
    };

    const data = await hubspotFetch("/crm/v3/objects/contacts/search", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    results.push(...data.results);
    after = data.paging?.next?.after;
  } while (after);

  return results;
}

async function readContactToDealAssociations(contactIds) {
  const map = new Map();
  const batches = chunk(contactIds, BATCH_SIZE);

  await runWithConcurrency(batches, async (batch) => {
    const data = await hubspotFetch("/crm/v4/associations/contacts/deals/batch/read", {
      method: "POST",
      body: JSON.stringify({ inputs: batch.map((id) => ({ id })) })
    });

    for (const item of data.results || []) {
      map.set(
        String(item.from.id),
        (item.to || []).map((entry) => String(entry.toObjectId))
      );
    }
  });

  return map;
}

async function readDeals(dealIds) {
  const map = new Map();
  const batches = chunk(dealIds, BATCH_SIZE);

  await runWithConcurrency(batches, async (batch) => {
    const data = await hubspotFetch("/crm/v3/objects/deals/batch/read", {
      method: "POST",
      body: JSON.stringify({
        inputs: batch.map((id) => ({ id })),
        properties: Object.values(PROPERTY_MAP.deal)
      })
    });

    for (const row of data.results || []) {
      map.set(String(row.id), row);
    }
  });

  return map;
}

function normalizeValue(value) {
  return String(value ?? "").trim();
}

function normalizeType(value) {
  const normalized = normalizeValue(value).toUpperCase();
  if (normalized.includes("FINANCE")) {
    return "Finance First";
  }
  if (normalized.includes("CAR")) {
    return "Car First";
  }
  return "";
}

function parseFilters(searchParams) {
  return {
    approvalType: searchParams.get("approvalType") || "all",
    paymentMode: searchParams.get("paymentMode") || "all",
    version: searchParams.get("version") || "all",
    status: searchParams.get("status") || "all",
    startDate: searchParams.get("startDate") || DEFAULT_START_DATE,
    endDate: searchParams.get("endDate") || ""
  };
}

function normalizePaymentMode(paymentMode, paymentMethod = "") {
  const rawMode = normalizeValue(paymentMode);
  const rawMethod = normalizeValue(paymentMethod);
  const modeKey = rawMode.toUpperCase();

  if (!rawMode && rawMethod) {
    return rawMethod.replaceAll("_", " ");
  }

  if (modeKey.includes("GLOBAL CARS AUS CREDIT") || modeKey.includes("CREDIT PTY LTD")) {
    return "In House Finance";
  }

  if (modeKey === "BYO") {
    return "BYO Finance";
  }

  if (modeKey === "100% ONLINE") {
    return "100% Online";
  }

  return rawMode || "Unknown";
}

function normalizeStatus(...values) {
  const raw = values.map(normalizeValue).find(Boolean) || "";
  const key = raw.toUpperCase();
  if (!raw) return "Unknown";
  if (key.includes("PRE_APPROVED") || key.includes("APPROVED") || key.includes("DEPOSIT RECEIVED")) return "Pre Approved";
  return "Not Pre Approved";
}

function normalizeCohort(value) {
  const raw = normalizeValue(value).toUpperCase();
  if (raw === "GOOD") return "Good";
  if (raw === "BAD") return "Bad";
  return "Unknown";
}

function isWithinDateRange(value, startDate, endDate) {
  if (!value) return false;
  const day = value.slice(0, 10);
  if (startDate && day < startDate) return false;
  if (endDate && day > endDate) return false;
  return true;
}

function breakdownCounts(rows, field) {
  const map = new Map();
  rows.forEach((row) => {
    const value = row[field] || "Unknown";
    map.set(value, (map.get(value) || 0) + 1);
  });
  return [...map.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

function cohortSummary(rows, type) {
  const subset = rows.filter((row) => row.approvalTypes.includes(type));
  const contactGood = subset.filter((row) => row.contactFinanceCohort === "Good").length;
  const contactBad = subset.filter((row) => row.contactFinanceCohort === "Bad").length;
  const dealGood = subset.filter((row) => row.dealUserCohort === "Good").length;
  const dealBad = subset.filter((row) => row.dealUserCohort === "Bad").length;
  return {
    type,
    total: subset.length,
    contactGood,
    contactBad,
    dealGood,
    dealBad
  };
}

function cohortByVersion(rows, version) {
  const subset = rows.filter((row) => row.overallVersion === version);
  const good = subset.filter((row) => {
    const cohort = row.contactFinanceCohort !== "Unknown" ? row.contactFinanceCohort : row.dealUserCohort;
    return cohort === "Good";
  }).length;
  const bad = subset.filter((row) => {
    const cohort = row.contactFinanceCohort !== "Unknown" ? row.contactFinanceCohort : row.dealUserCohort;
    return cohort === "Bad";
  }).length;
  return { version, good, bad, total: good + bad };
}

function versionStatusSummary(rows, version) {
  const subset = rows.filter((row) => row.overallVersion === version);
  return {
    version,
    total: subset.length,
    preApproved: subset.filter((row) => row.overallStatus === "Pre Approved").length,
    rejected: subset.filter((row) => row.overallStatus === "Not Pre Approved").length,
    bookings: subset.filter((row) => row.financeFirstBookingConfirmedCount > 0 || row.carFirstBookingConfirmedCount > 0).length
  };
}

function customerKey(contact) {
  return normalizeValue(contact.email).toLowerCase() || normalizeValue(contact.phone).replace(/\D/g, "") || contact.id;
}

function toDateValue(value) {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? Number.MAX_SAFE_INTEGER : timestamp;
}

function summarizePaymentModes(deals) {
  const summary = new Map();
  deals.forEach((deal) => {
    const mode = deal.paymentMode || "Unknown";
    summary.set(mode, (summary.get(mode) || 0) + 1);
  });

  return [...summary.entries()]
    .map(([paymentMode, count]) => ({ paymentMode, count }))
    .sort((left, right) => right.count - left.count);
}

function versionSplit(rows, versionField, bookingField) {
  const summary = new Map();
  rows.forEach((row) => {
    const version = row[versionField] || "Unknown";
    const entry = summary.get(version) || { version, customers: 0, bookingConfirmed: 0 };
    entry.customers += 1;
    entry.bookingConfirmed += Number(row[bookingField] || 0);
    summary.set(version, entry);
  });

  return [...summary.values()].sort((left, right) => left.version.localeCompare(right.version));
}

function countBookingCustomers(rows, bookingField) {
  return rows.filter((row) => Number(row[bookingField] || 0) > 0).length;
}

async function buildDashboard(filters = { approvalType: "all", paymentMode: "all", version: "all" }) {
  const rawContacts = await searchAllContacts();
  const contacts = rawContacts
    .map((row) => ({
      id: String(row.id),
      email: normalizeValue(row.properties[PROPERTY_MAP.contact.email]),
      phone: normalizeValue(row.properties[PROPERTY_MAP.contact.phone]),
      preApprovalType: normalizeType(row.properties[PROPERTY_MAP.contact.preApprovalType]),
      preApprovalVersion: normalizeValue(row.properties[PROPERTY_MAP.contact.preApprovalVersion]) || "Unknown",
      paymentMode: normalizeValue(row.properties[PROPERTY_MAP.contact.paymentMode]),
      preApprovalStartDate: normalizeValue(row.properties[PROPERTY_MAP.contact.preApprovalStartDate]),
      createdDate: normalizeValue(row.properties[PROPERTY_MAP.contact.createdDate]),
      financeStatus: normalizeStatus(row.properties[PROPERTY_MAP.contact.financeStatus]),
      userFinanceCohort: normalizeCohort(row.properties[PROPERTY_MAP.contact.userFinanceCohort])
    }))
    .filter((row) => row.preApprovalType === "Finance First" || row.preApprovalType === "Car First");

  const associationMap = await readContactToDealAssociations(contacts.map((contact) => contact.id));
  const dealIds = [...new Set(contacts.flatMap((contact) => associationMap.get(contact.id) || []))];
  const rawDeals = await readDeals(dealIds);

  const customers = new Map();

  contacts.forEach((contact) => {
    const key = customerKey(contact);
    const shell = customers.get(key) || {
      customerKey: key,
      contacts: [],
      deals: [],
      firstTouchLine: "",
      firstTouchDate: ""
    };
    shell.contacts.push(contact);
    customers.set(key, shell);
  });

  contacts.forEach((contact) => {
    const key = customerKey(contact);
    const shell = customers.get(key);
    const relatedDeals = (associationMap.get(contact.id) || [])
      .map((dealId) => rawDeals.get(dealId))
      .filter(Boolean)
      .map((row) => ({
        id: String(row.id),
        dealName: normalizeValue(row.properties[PROPERTY_MAP.deal.dealName]),
        preApprovalType: normalizeType(row.properties[PROPERTY_MAP.deal.preApprovalType]),
        preApprovalVersion: normalizeValue(row.properties[PROPERTY_MAP.deal.preApprovalVersion]) || "Unknown",
        paymentMode: normalizePaymentMode(
          row.properties[PROPERTY_MAP.deal.paymentMode],
          row.properties[PROPERTY_MAP.deal.paymentMethod]
        ) || normalizePaymentMode(contact.paymentMode) || "Unknown",
        bookingConfirmDate: normalizeValue(row.properties[PROPERTY_MAP.deal.bookingConfirmDate]),
        createdDate: normalizeValue(row.properties[PROPERTY_MAP.deal.createdDate]),
        preApprovalStartDate: normalizeValue(row.properties[PROPERTY_MAP.deal.preApprovalStartDate]),
        preApprovalStatus: normalizeStatus(row.properties[PROPERTY_MAP.deal.customerFinanceStatus]),
        userCohort: normalizeCohort(row.properties[PROPERTY_MAP.deal.userCohort]),
        line: normalizeType(row.properties[PROPERTY_MAP.deal.preApprovalType]) || contact.preApprovalType
      }));

    shell.deals.push(...relatedDeals);
  });

  const customerRows = [...customers.values()].map((customer) => {
    const financeContacts = customer.contacts.filter((contact) => contact.preApprovalType === "Finance First");
    const carContacts = customer.contacts.filter((contact) => contact.preApprovalType === "Car First");
    const financeDeals = customer.deals.filter((deal) => deal.line === "Finance First");
    const carDeals = customer.deals.filter((deal) => deal.line === "Car First");
    const financeBookingDeals = financeDeals.filter((deal) => Boolean(deal.bookingConfirmDate));
    const carBookingDeals = carDeals.filter((deal) => Boolean(deal.bookingConfirmDate));
    const earliestCarDeal = [...carDeals].sort((left, right) => toDateValue(left.createdDate) - toDateValue(right.createdDate))[0];
    const allTypes = new Set([
      ...financeContacts.map(() => "Finance First"),
      ...carContacts.map(() => "Car First"),
      ...financeDeals.map(() => "Finance First"),
      ...carDeals.map(() => "Car First")
    ]);
    const allPaymentModes = [
      ...financeBookingDeals.map((deal) => deal.paymentMode),
      ...carBookingDeals.map((deal) => deal.paymentMode)
    ].filter(Boolean);
    const allVersions = [
      ...financeContacts.map((contact) => contact.preApprovalVersion || "Unknown"),
      ...financeDeals.map((deal) => deal.preApprovalVersion || "Unknown"),
      ...carDeals.map((deal) => deal.preApprovalVersion || "Unknown")
    ].filter(Boolean);
    const anchorStartDate =
      financeContacts.map((contact) => contact.preApprovalStartDate).find(Boolean) ||
      carContacts.map((contact) => contact.preApprovalStartDate).find(Boolean) ||
      [...financeDeals, ...carDeals].map((deal) => deal.preApprovalStartDate).find(Boolean) ||
      "";
    const contactStatuses = financeContacts.map((contact) => contact.financeStatus).filter(Boolean);
    const dealStatuses = [...financeDeals, ...carDeals].map((deal) => deal.preApprovalStatus).filter(Boolean);
    const contactFinanceCohorts = financeContacts.map((contact) => contact.userFinanceCohort).filter(Boolean);
    const dealUserCohorts = [...financeDeals, ...carDeals].map((deal) => deal.userCohort).filter(Boolean);
    const overallVersion =
      allVersions.find((value) => value === "Quick") ||
      allVersions.find((value) => value === "Normal") ||
      allVersions[0] ||
      "Unknown";
    const overallStatus =
      contactStatuses.find((value) => value !== "Unknown") ||
      dealStatuses.find((value) => value !== "Unknown") ||
      contactStatuses[0] ||
      dealStatuses[0] ||
      "Unknown";

    return {
      customerKey: customer.customerKey,
      preApprovalStartDate: anchorStartDate,
      approvalTypes: [...allTypes],
      overallVersion,
      overallStatus,
      contactFinanceCohort: contactFinanceCohorts.find((value) => value !== "Unknown") || contactFinanceCohorts[0] || "Unknown",
      dealUserCohort: dealUserCohorts.find((value) => value !== "Unknown") || dealUserCohorts[0] || "Unknown",
      financeFirstVersion: financeContacts[0]?.preApprovalVersion || "Unknown",
      financeFirstDealCount: financeDeals.length,
      financeFirstBookingConfirmedCount: financeBookingDeals.length,
      financeFirstPaymentModes: summarizePaymentModes(financeBookingDeals),
      carFirstVersion: earliestCarDeal?.preApprovalVersion || "Unknown",
      carFirstDealCount: carDeals.length,
      carFirstBookingConfirmedCount: carBookingDeals.length,
      carFirstPaymentModes: summarizePaymentModes(carBookingDeals),
      paymentModes: [...new Set(allPaymentModes)],
      versions: [...new Set(allVersions)]
    };
  });

  const filteredRows = customerRows.filter((row) => {
    const typeOk = filters.approvalType === "all" || row.approvalTypes.includes(filters.approvalType);
    const paymentOk = filters.paymentMode === "all" || row.paymentModes.includes(filters.paymentMode);
    const versionOk = filters.version === "all" || row.versions.includes(filters.version) || row.overallVersion === filters.version;
    const statusOk = filters.status === "all" || row.overallStatus === filters.status;
    const dateOk = isWithinDateRange(row.preApprovalStartDate, filters.startDate, filters.endDate);
    return typeOk && paymentOk && versionOk && statusOk && dateOk;
  });

  const financeRows = filteredRows.filter((row) => row.approvalTypes.includes("Finance First"));
  const carRows = filteredRows.filter((row) => row.approvalTypes.includes("Car First"));
  const bookedRows = filteredRows.filter((row) => row.financeFirstBookingConfirmedCount > 0 || row.carFirstBookingConfirmedCount > 0);
  const overallBookingCustomers = bookedRows.length;
  const paymentModeOptions = [...new Set(customerRows.flatMap((row) => row.paymentModes))].sort();
  const versionOptions = [...new Set(customerRows.flatMap((row) => row.versions))].sort();
  const statusOptions = [...new Set(customerRows.map((row) => row.overallStatus))].filter(Boolean).sort();
  const overallQuickUsers = filteredRows.filter((row) => row.overallVersion === "Quick").length;
  const overallQuickBookings = filteredRows.filter((row) => row.overallVersion === "Quick" && (row.financeFirstBookingConfirmedCount > 0 || row.carFirstBookingConfirmedCount > 0)).length;
  const overallNormalUsers = filteredRows.filter((row) => row.overallVersion === "Normal").length;
  const overallNormalBookings = filteredRows.filter((row) => row.overallVersion === "Normal" && (row.financeFirstBookingConfirmedCount > 0 || row.carFirstBookingConfirmedCount > 0)).length;
  const cohortByType = [cohortSummary(filteredRows, "Finance First"), cohortSummary(filteredRows, "Car First")];
  const cohortByVersionRows = [cohortByVersion(filteredRows, "Quick"), cohortByVersion(filteredRows, "Normal")];
  const versionStatusRows = [versionStatusSummary(filteredRows, "Quick"), versionStatusSummary(filteredRows, "Normal")];

  return {
    generatedAt: new Date().toISOString(),
    startDate: DEFAULT_START_DATE,
    mapping: {
      contact: Object.entries(PROPERTY_MAP.contact).map(([key, value]) => ({ key, value })),
      deal: Object.entries(PROPERTY_MAP.deal).map(([key, value]) => ({ key, value }))
    },
    meta: {
      contactCount: contacts.length,
      dealCount: dealIds.length
    },
    filters: {
      applied: filters,
      options: {
        approvalTypes: ["Finance First", "Car First"],
        paymentModes: paymentModeOptions,
        versions: versionOptions,
        statuses: statusOptions
      }
    },
    summaryCards: [
      {
        label: "Overall Pre-Approval Users",
        value: filteredRows.length,
        icon: "👥",
        tone: "c-blue",
        description: "Unique customers in the selected date window"
      },
      {
        label: "Overall Bookings",
        value: overallBookingCustomers,
        icon: "🎯",
        tone: "c-green",
        description: "Unique customers with at least one booking-confirmed deal"
      },
      {
        label: "Quick Users",
        value: filteredRows.filter((row) => row.overallVersion === "Quick").length,
        icon: "🏦",
        tone: "c-red",
        description: `${filteredRows.filter((row) => row.overallVersion === "Quick" && (row.financeFirstBookingConfirmedCount > 0 || row.carFirstBookingConfirmedCount > 0)).length} booked`
      },
      {
        label: "Normal Users",
        value: filteredRows.filter((row) => row.overallVersion === "Normal").length,
        icon: "🚗",
        tone: "c-amber",
        description: `${filteredRows.filter((row) => row.overallVersion === "Normal" && (row.financeFirstBookingConfirmedCount > 0 || row.carFirstBookingConfirmedCount > 0)).length} booked`
      },
      {
        label: "Pre Approved Users",
        value: filteredRows.filter((row) => row.overallStatus === "Pre Approved").length,
        icon: "📍",
        tone: "c-purple",
        description: `${filteredRows.filter((row) => row.overallStatus === "Not Pre Approved").length} not pre approved, ${filteredRows.filter((row) => row.overallStatus === "Unknown").length} unknown`
      }
    ],
    comparison: {
      financeFirst: {
      versionRows: versionSplit(financeRows, "financeFirstVersion", "financeFirstBookingConfirmedCount"),
      paymentModeRows: summarizePaymentModes(financeRows.flatMap((row) => expandPaymentRows(row.financeFirstPaymentModes)))
      },
      carFirst: {
      versionRows: versionSplit(carRows, "carFirstVersion", "carFirstBookingConfirmedCount"),
      paymentModeRows: summarizePaymentModes(carRows.flatMap((row) => expandPaymentRows(row.carFirstPaymentModes)))
      }
    },
    breakdowns: {
      version: breakdownCounts(filteredRows, "overallVersion"),
      status: breakdownCounts(filteredRows, "overallStatus"),
      contactFinanceCohort: breakdownCounts(filteredRows, "contactFinanceCohort"),
      dealUserCohort: breakdownCounts(filteredRows, "dealUserCohort"),
      cohortByType,
      cohortByVersion: cohortByVersionRows
    },
    overallVersionSummary: {
      quickUsers: overallQuickUsers,
      quickBookings: overallQuickBookings,
      normalUsers: overallNormalUsers,
      normalBookings: overallNormalBookings
    },
    versionStatusRows,
    customerRows: filteredRows
  };
}

function expandPaymentRows(rows) {
  return rows.flatMap((row) => Array.from({ length: row.count }, () => ({ paymentMode: row.paymentMode })));
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function runWithConcurrency(items, worker) {
  let index = 0;

  async function runNext() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      await worker(items[currentIndex]);
    }
  }

  const workers = Array.from({ length: Math.min(MAX_PARALLEL, items.length) }, () => runNext());
  await Promise.all(workers);
}

async function getDashboardPayload() {
  if (cachedDashboard && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedDashboard;
  }

  cachedDashboard = await buildDashboard();
  cachedAt = Date.now();
  return cachedDashboard;
}

function serveFile(filePath, response) {
  const extension = path.extname(filePath);
  const typeMap = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8"
  };

  fs.readFile(filePath, (error, contents) => {
    if (error) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    response.writeHead(200, { "Content-Type": typeMap[extension] || "application/octet-stream" });
    response.end(contents);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Cache-Control"
  };

  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders);
    response.end();
    return;
  }

  if (url.pathname === "/api/dashboard") {
    try {
      const filters = parseFilters(url.searchParams);
      if (url.searchParams.get("refresh") === "1") {
        cachedDashboard = null;
        cachedAt = 0;
      }
      const payload = cachedDashboard && Date.now() - cachedAt < CACHE_TTL_MS && url.searchParams.get("refresh") !== "1" && JSON.stringify(filters) === JSON.stringify(cachedDashboard.filters?.applied)
        ? cachedDashboard
        : await buildDashboard(filters);
      cachedDashboard = payload;
      cachedAt = Date.now();
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", ...corsHeaders });
      response.end(JSON.stringify(payload));
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8", ...corsHeaders });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  const filePath = url.pathname === "/" ? path.join(__dirname, "index.html") : path.join(__dirname, url.pathname);
  serveFile(filePath, response);
});

server.listen(PORT, () => {
  console.log(`Pre-approval dashboard running at http://localhost:${PORT}`);
});
