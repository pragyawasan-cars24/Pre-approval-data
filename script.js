const statusMessage = document.getElementById("statusMessage");
const refreshButton = document.getElementById("refreshButton");
const statusDot = document.getElementById("statusDot");
const statusLabel = document.getElementById("statusLabel");
const updatedText = document.getElementById("updatedText");
const startDateFilter = document.getElementById("startDateFilter");
const endDateFilter = document.getElementById("endDateFilter");
const approvalTypeFilter = document.getElementById("approvalTypeFilter");
const paymentModeFilter = document.getElementById("paymentModeFilter");
const versionFilter = document.getElementById("versionFilter");
const statusFilter = document.getElementById("statusFilter");
const tableSearch = document.getElementById("tableSearch");
const summaryCardsEl = document.getElementById("summaryCards");
const financeVersionTableEl = document.getElementById("financeVersionTable");
const contactCohortBreakdownEl = document.getElementById("contactCohortBreakdown");
const dealCohortBreakdownEl = document.getElementById("dealCohortBreakdown");
const detailTableEl = document.getElementById("detailTable");
const mappingListEl = document.getElementById("mappingList");
const API_BASE = window.location.protocol === "file:" ? "http://localhost:4173" : "";
const PAGE_SIZE = 10;

let lastRows = [];
let currentPage = 1;

refreshButton.addEventListener("click", () => loadDashboard(true));
[startDateFilter, endDateFilter, approvalTypeFilter, paymentModeFilter, versionFilter, statusFilter].forEach((element) => {
  element.addEventListener("change", () => {
    currentPage = 1;
    loadDashboard(false);
  });
});
tableSearch.addEventListener("input", () => {
  currentPage = 1;
  renderDetailTable(lastRows);
});

void loadDashboard(false);

async function loadDashboard(forceRefresh) {
  statusMessage.className = "notice info";
  statusMessage.textContent = "Refreshing live data from HubSpot...";
  statusDot.className = "dot loading";
  statusLabel.textContent = "Refreshing live data…";
  refreshButton.disabled = true;

  try {
    const params = new URLSearchParams();
    if (forceRefresh) params.set("refresh", "1");
    if (startDateFilter.value) params.set("startDate", startDateFilter.value);
    if (endDateFilter.value) params.set("endDate", endDateFilter.value);
    if (approvalTypeFilter.value !== "all") params.set("approvalType", approvalTypeFilter.value);
    if (paymentModeFilter.value !== "all") params.set("paymentMode", paymentModeFilter.value);
    if (versionFilter.value !== "all") params.set("version", versionFilter.value);
    if (statusFilter.value !== "all") params.set("status", statusFilter.value);

    const response = await fetch(`${API_BASE}/api/dashboard?${params.toString()}`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" }
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Failed to load dashboard");
    }

    renderMappings(payload.mapping);
    syncFilter(approvalTypeFilter, payload.filters.options.approvalTypes, "All Types", payload.filters.applied.approvalType);
    syncFilter(paymentModeFilter, payload.filters.options.paymentModes, "All Payment Modes", payload.filters.applied.paymentMode);
    syncFilter(versionFilter, payload.filters.options.versions, "All Versions", payload.filters.applied.version);
    syncFilter(statusFilter, payload.filters.options.statuses, "All Statuses", payload.filters.applied.status);
    startDateFilter.value = payload.filters.applied.startDate || "";
    endDateFilter.value = payload.filters.applied.endDate || "";

    renderSummary(payload.summaryCards);
    renderComparisonTable(
      financeVersionTableEl,
      payload.versionStatusRows
    );
    renderVersionPieCard(contactCohortBreakdownEl, payload.breakdowns.cohortByVersion.find((row) => row.version === "Quick"));
    renderVersionPieCard(dealCohortBreakdownEl, payload.breakdowns.cohortByVersion.find((row) => row.version === "Normal"));

    lastRows = payload.customerRows;
    renderDetailTable(lastRows);

    statusMessage.textContent = `Anchored on pre approval start date. Last refreshed: ${formatDateTime(payload.generatedAt)}. Contacts ${payload.meta.contactCount}, deals ${payload.meta.dealCount}.`;
    statusDot.className = "dot live";
    statusLabel.textContent = "Live from HubSpot";
    updatedText.textContent = `Updated ${formatDateTime(payload.generatedAt)}`;
  } catch (error) {
    console.error(error);
    statusMessage.className = "notice error";
    statusMessage.textContent = error.message;
    statusDot.className = "dot error";
    statusLabel.textContent = "Error loading data";
    updatedText.textContent = "Updated -";
  } finally {
    refreshButton.disabled = false;
  }
}

function syncFilter(select, options, allLabel, selected) {
  const current = new Set(["all", ...options]);
  select.innerHTML = [`<option value="all">${allLabel}</option>`].concat(options.map((option) => `<option value="${option}">${option}</option>`)).join("");
  select.value = current.has(selected) ? selected : "all";
}

function renderMappings(mapping) {
  mappingListEl.innerHTML = "";
  const sections = [
    { title: "Contact properties", rows: mapping.contact },
    { title: "Deal properties", rows: mapping.deal }
  ];

  sections.forEach((section) => {
    const card = document.createElement("div");
    card.className = "mapping-item";
    card.innerHTML = `<strong>${section.title}</strong>${section.rows.map((row) => `<div><code>${row.key}</code>: ${row.value}</div>`).join("")}`;
    mappingListEl.appendChild(card);
  });
}

function renderSummary(cards) {
  const overallUsers = cards.find((card) => card.label === "Overall Pre-Approval Users")?.value || 0;
  summaryCardsEl.innerHTML = "";
  cards.forEach((card) => {
    let desc = card.description || "";
    if (overallUsers && card.label === "Overall Bookings") {
      desc = `${desc} (${formatPercent(card.value, overallUsers)})`;
    }
    if (overallUsers && (card.label === "Quick Users" || card.label === "Normal Users")) {
      desc = `${desc} (${formatPercent(card.value, overallUsers)} of users)`;
    }
    const article = document.createElement("article");
    article.className = `metric-card ${card.tone || "c-blue"}`;
    article.innerHTML = `
      <div class="metric-icon ${card.tone || "c-blue"}">${card.icon || "•"}</div>
      <div class="metric-value ${card.tone || "c-blue"}">${card.value}</div>
      <div class="metric-label">${card.label}</div>
      <div class="metric-desc">${desc}</div>
    `;
    summaryCardsEl.appendChild(article);
  });
}

function renderComparisonTable(container, rows) {
  const bodyRows = rows.length
    ? rows.map((row) => {
        const preApprovedLabel = `${row.preApproved} (${formatPercent(row.preApproved, row.total)})`;
        const rejectedLabel = `${row.rejected} (${formatPercent(row.rejected, row.total)})`;
        const bookingLabel = `${row.bookings} (${formatPercent(row.bookings, row.total)})`;
        return `<tr><td>${row.version}</td><td>${row.total}</td><td>${preApprovedLabel}</td><td>${rejectedLabel}</td><td>${bookingLabel}</td></tr>`;
      }).join("")
    : '<tr><td colspan="5" class="empty-state">No rows found.</td></tr>';
  container.innerHTML = `
    <table>
      <thead>
        <tr><th>Version</th><th>Total</th><th>Pre Approved</th><th>Rejected</th><th>Bookings</th></tr>
      </thead>
      <tbody>${bodyRows}</tbody>
    </table>
  `;
}

function renderVersionPieCard(container, row) {
  const title = row?.version || "Unknown";
  const good = row?.good || 0;
  const bad = row?.bad || 0;
  const total = row?.total || 0;
  const goodPercent = total ? Math.round((good / total) * 100) : 0;
  const badPercent = total ? 100 - goodPercent : 0;
  const radius = 70;
  const cx = 80;
  const cy = 80;
  const goodAngle = total ? (good / total) * Math.PI * 2 : 0;
  const goodPath = describeSlice(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + goodAngle);
  const badPath = describeSlice(cx, cy, radius, -Math.PI / 2 + goodAngle, -Math.PI / 2 + Math.PI * 2);

  container.innerHTML = `
    <div class="mini-title">${title}</div>
    <div class="pie-card">
      <svg class="pie-svg" viewBox="0 0 160 160" aria-label="${title} cohort pie chart">
        ${good > 0 ? `<path class="pie-slice good" data-label="Good" data-count="${good}" data-percent="${goodPercent}" d="${goodPath}"></path>` : ""}
        ${bad > 0 ? `<path class="pie-slice bad" data-label="Bad" data-count="${bad}" data-percent="${badPercent}" d="${badPath}"></path>` : ""}
        <circle cx="${cx}" cy="${cy}" r="36" fill="white"></circle>
        <text x="${cx}" y="${cy - 2}" text-anchor="middle" class="pie-center-value">${total}</text>
        <text x="${cx}" y="${cy + 16}" text-anchor="middle" class="pie-center-label">Total</text>
      </svg>
      <div class="pie-legend">
        <button type="button" class="legend-btn good" data-label="Good" data-count="${good}" data-percent="${goodPercent}">Good: <strong>${good}</strong></button>
        <button type="button" class="legend-btn bad" data-label="Bad" data-count="${bad}" data-percent="${badPercent}">Bad: <strong>${bad}</strong></button>
        <div class="pie-detail">Click a slice</div>
      </div>
    </div>
  `;

  const detail = container.querySelector(".pie-detail");
  const clickable = container.querySelectorAll(".pie-slice, .legend-btn");
  clickable.forEach((element) => {
    element.addEventListener("click", () => {
      const label = element.getAttribute("data-label");
      const count = element.getAttribute("data-count");
      const percent = element.getAttribute("data-percent");
      detail.textContent = `${label}: ${count} users (${percent}%)`;
    });
  });
}

function polarToCartesian(cx, cy, radius, angle) {
  return {
    x: cx + radius * Math.cos(angle),
    y: cy + radius * Math.sin(angle)
  };
}

function describeSlice(cx, cy, radius, startAngle, endAngle) {
  const start = polarToCartesian(cx, cy, radius, startAngle);
  const end = polarToCartesian(cx, cy, radius, endAngle);
  const largeArcFlag = endAngle - startAngle > Math.PI ? 1 : 0;
  return [
    `M ${cx} ${cy}`,
    `L ${start.x} ${start.y}`,
    `A ${radius} ${radius} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`,
    "Z"
  ].join(" ");
}

function renderDetailTable(rows) {
  const columns = [
    "customerKey",
    "preApprovalStartDate",
    "approvalTypes",
    "overallStatus",
    "overallVersion",
    "contactFinanceCohort",
    "dealUserCohort",
    "financeFirstVersion",
    "financeFirstDealCount",
    "financeFirstBookingConfirmedCount",
    "carFirstVersion",
    "carFirstDealCount",
    "carFirstBookingConfirmedCount",
    "paymentModes"
  ];

  const query = tableSearch.value.trim().toLowerCase();
  const filteredRows = !query ? rows : rows.filter((row) =>
    [
      row.customerKey,
      row.preApprovalStartDate,
      ...(row.approvalTypes || []),
      row.overallStatus,
      row.overallVersion,
      row.contactFinanceCohort,
      row.dealUserCohort,
      ...(row.paymentModes || [])
    ]
      .join(" ")
      .toLowerCase()
      .includes(query)
  );

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  currentPage = Math.min(currentPage, pageCount);
  const pageRows = filteredRows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  detailTableEl.innerHTML = `
    <div class="table-wrap">
      <table class="deal-table">
        <thead><tr>${columns.map((column) => `<th>${escapeHtml(headerLabel(column))}</th>`).join("")}</tr></thead>
        <tbody>
          ${pageRows.length ? pageRows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(formatCell(row[column]))}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${columns.length}" class="empty-state">No rows match the current filters.</td></tr>`}
        </tbody>
      </table>
    </div>
    <div class="pagination">
      <div>Showing ${filteredRows.length ? (currentPage - 1) * PAGE_SIZE + 1 : 0}-${Math.min(currentPage * PAGE_SIZE, filteredRows.length)} of ${filteredRows.length}</div>
      <div class="page-btns">
        <button type="button" class="btn" ${currentPage === 1 ? "disabled" : ""} data-page="prev">Prev</button>
        <span class="page-chip">Page ${currentPage} / ${pageCount}</span>
        <button type="button" class="btn" ${currentPage === pageCount ? "disabled" : ""} data-page="next">Next</button>
      </div>
    </div>
  `;

  detailTableEl.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", () => {
      currentPage += button.dataset.page === "prev" ? -1 : 1;
      renderDetailTable(lastRows);
    });
  });
}

function headerLabel(key) {
  const labels = {
    customerKey: "Customer",
    preApprovalStartDate: "Pre-Approval Start",
    approvalTypes: "Type",
    overallStatus: "Pre-Approval Status",
    overallVersion: "Version",
    contactFinanceCohort: "Contact Cohort",
    dealUserCohort: "Deal Cohort",
    financeFirstVersion: "Finance Version",
    financeFirstDealCount: "Finance Deals",
    financeFirstBookingConfirmedCount: "Finance Bookings",
    carFirstVersion: "Car Version",
    carFirstDealCount: "Car Deals",
    carFirstBookingConfirmedCount: "Car Bookings",
    paymentModes: "Payment Mode"
  };
  return labels[key] || key;
}

function formatCell(value) {
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  return String(value ?? "");
}

function formatDateTime(value) {
  return new Date(value).toLocaleString();
}

function formatPercent(value, total) {
  if (!total) return "0%";
  return `${Math.round((value / total) * 100)}%`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
