// MedCheck frontend.
// The browser only talks to our own Flask API (/api/...), never to openFDA
// directly, so the API key stays on the server.

const $ = (selector) => document.querySelector(selector);

const searchView = $("#search-view");
const drugView = $("#drug-view");
const form = $("#search-form");
const input = $("#q");
const formError = $("#form-error");
const controls = $("#controls");
const sortSelect = $("#sort");
const statusBox = $("#status");
const resultsList = $("#results");
const suggestions = $("#suggestions");

// Same rule as the backend: 2-50 letters, numbers, spaces or hyphens.
const VALID_QUERY = /^[A-Za-z0-9 \-]{2,50}$/;

const EXAMPLES = ["ibuprofen", "amoxicillin", "metformin", "acetaminophen"];

// openFDA uses US names. Common names used elsewhere -> the US name.
const US_NAMES = {
  paracetamol: "acetaminophen",
  salbutamol: "albuterol",
  adrenaline: "epinephrine",
  frusemide: "furosemide",
  glibenclamide: "glyburide",
  lignocaine: "lidocaine",
};

const RECENT_KEY = "medcheck-recent";

let current = { q: "", type: "all", sort: "name" };
let lastSearchHash = "";
let requestId = 0; // ignore answers to old requests if the user moved on


// ------------------------------------------------------------- helpers

// Create an element safely. Text always goes in as text (textContent),
// never as HTML, so data from the API cannot inject code (XSS protection).
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child == null || child === false || child === "") continue;
    node.append(child); // plain strings become text nodes, which is safe
  }
  return node;
}

// Call our backend and return its JSON, or throw an Error with a
// message that is friendly enough to show to the user.
async function api(path) {
  let response;
  try {
    response = await fetch(path);
  } catch {
    throw new Error("Can't reach MedCheck. Check your internet connection and try again.");
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    // not JSON: handled below
  }

  if (!response.ok) {
    throw new Error((data && data.error) || "Something went wrong. Please try again.");
  }
  if (!data) {
    throw new Error("The server sent an unexpected response. Please try again.");
  }
  return data;
}

// "IBUPROFEN AND FAMOTIDINE" -> "Ibuprofen and famotidine"
function sentenceCase(text) {
  if (!text || text === "Unknown") return "";
  const lower = text.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// Cut long label text to a readable length, ending at a full sentence.
function shorten(text, max = 260) {
  if (!text || text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastStop = cut.lastIndexOf(". ");
  if (lastStop > 80) return cut.slice(0, lastStop + 1);
  return cut.slice(0, cut.lastIndexOf(" ")) + " …";
}

// Some labels are ALL CAPS or all lowercase: "CHILDRENS IBUPROFEN" -> "Childrens Ibuprofen"
function niceName(name) {
  if (!name) return "";
  if (name !== name.toUpperCase() && name !== name.toLowerCase()) return name;
  return name.toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

// Label text often starts in lowercase ("temporarily relieves..."): fix the first letter.
function capitalize(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function typeName(type) {
  return type === "OTC" ? "Over the counter" : "Prescription";
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function showView(view) {
  searchView.hidden = view !== searchView;
  drugView.hidden = view !== drugView;
}

function loadingLine(text) {
  return el("p", { class: "status" }, el("span", { class: "spinner", "aria-hidden": "true" }), text);
}

// A friendly error box, with a "Try again" button when we know how to retry.
function errorBox(message, retry) {
  return el("div", { class: "message error", role: "alert" },
    el("strong", { text: "Something went wrong" }),
    message,
    retry && el("div", {}, el("button", { class: "link-button", type: "button", onclick: retry }, "Try again")),
  );
}

function searchHash(q, type, sort) {
  return "#/search?" + new URLSearchParams({ q, type, sort }).toString();
}

function go(hash) {
  if (location.hash === hash) route(); // same URL: hashchange won't fire
  else location.hash = hash;
}


// ------------------------------------------------------ recent searches
// Saved only in this browser. Wrapped in try/catch because storage can be
// blocked (private mode), and the app must still work without it.

function getRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY)) || [];
  } catch {
    return [];
  }
}

function saveRecent(q) {
  try {
    const list = [q.toLowerCase(), ...getRecent().filter((x) => x !== q.toLowerCase())];
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 5)));
  } catch {
    // ignore: recent searches are just a convenience
  }
}

function renderSuggestions() {
  const recent = getRecent();
  const words = recent.length ? recent : EXAMPLES;
  suggestions.replaceChildren(
    recent.length ? "Recent: " : "Try: ",
    ...words.map((word) =>
      el("button", { type: "button", onclick: () => go(searchHash(word, "all", "name")) }, word)),
  );
  suggestions.hidden = false;
}


// ------------------------------------------------------------- routing
// The URL decides what is on screen, so the browser back button works and
// searches can be shared:  #/   #/search?q=...   #/drug/<id>

function route() {
  const hash = location.hash.slice(1) || "/";
  const [path, queryString = ""] = hash.split("?");
  const params = new URLSearchParams(queryString);

  if (path.startsWith("/drug/")) {
    showDrug(decodeURIComponent(path.slice("/drug/".length)));
  } else if (path === "/search" && params.get("q")) {
    showSearch(params.get("q"), params.get("type") || "all", params.get("sort") || "name");
  } else {
    showHome();
  }
}


// -------------------------------------------------------------- screens

function showHome() {
  requestId++;
  showView(searchView);
  document.title = "MedCheck: Know your medicine";
  current = { q: "", type: "all", sort: "name" };
  input.value = "";
  formError.hidden = true;
  controls.hidden = true;
  statusBox.replaceChildren();
  resultsList.replaceChildren();
  renderSuggestions();
}

async function showSearch(q, type, sort) {
  showView(searchView);
  document.title = `${q}: MedCheck`;
  lastSearchHash = location.hash;
  current = { q, type, sort };

  input.value = q;
  sortSelect.value = sort;
  document.querySelectorAll(".chip").forEach((chip) => {
    chip.setAttribute("aria-pressed", String(chip.dataset.type === type));
  });
  formError.hidden = true;
  controls.hidden = false;
  suggestions.hidden = true;
  resultsList.replaceChildren();

  if (!VALID_QUERY.test(q)) {
    controls.hidden = true;
    statusBox.replaceChildren(errorBox("Please type 2 to 50 letters, numbers or spaces."));
    return;
  }

  statusBox.replaceChildren(loadingLine("Searching…"));
  const myRequest = ++requestId;

  try {
    const data = await api(`/api/search?${new URLSearchParams({ q, type, sort })}`);
    if (myRequest !== requestId) return;
    saveRecent(q);
    renderResults(data, q, type);
  } catch (err) {
    if (myRequest !== requestId) return;
    statusBox.replaceChildren(errorBox(err.message, () => showSearch(q, type, sort)));
  }
}

function renderResults(data, q, type) {
  if (data.count === 0) {
    statusBox.replaceChildren(emptyMessage(q, type));
    return;
  }

  statusBox.replaceChildren(`${plural(data.count, "medicine")} found`);
  resultsList.replaceChildren(...data.results.map((drug) => {
    const details = [sentenceCase(drug.generic), typeName(drug.type), drug.manufacturer]
      .filter((part) => part && part !== "Unknown")
      .join(" · ");
    return el("li", {},
      el("a", { href: `#/drug/${encodeURIComponent(drug.id)}` },
        el("span", {},
          el("span", { class: "name", text: niceName(drug.brand) }),
          el("span", { class: "sub", text: details })),
        el("span", { class: "arrow", "aria-hidden": "true", text: "›" })));
  }));
}

function emptyMessage(q, type) {
  // Filtered to OTC/Rx only: suggest showing all types instead.
  if (type !== "all") {
    return el("div", { class: "message" },
      el("strong", { text: `No ${type === "otc" ? "over-the-counter" : "prescription"} results for “${q}”` }),
      el("button", { class: "link-button", type: "button",
        onclick: () => go(searchHash(q, "all", current.sort)) }, "Show all types"));
  }

  const usName = US_NAMES[q.toLowerCase()];
  return el("div", { class: "message" },
    el("strong", { text: `No results for “${q}”` }),
    "This data comes from the U.S. FDA, so some local brand names are not listed. Try the generic (active ingredient) name.",
    usName && el("div", {},
      el("button", { class: "link-button", type: "button",
        onclick: () => go(searchHash(usName, "all", "name")) }, `Search for “${usName}” instead`)));
}


// ------------------------------------------------------- medicine screen

async function showDrug(id) {
  showView(drugView);
  window.scrollTo(0, 0);
  drugView.replaceChildren(backLink(), loadingLine("Loading medicine…"));
  const myRequest = ++requestId;

  let label;
  try {
    label = await api(`/api/drug/${encodeURIComponent(id)}`);
  } catch (err) {
    if (myRequest !== requestId) return;
    drugView.replaceChildren(backLink(), errorBox(err.message, () => showDrug(id)));
    return;
  }
  if (myRequest !== requestId) return;

  document.title = `${niceName(label.brand)}: MedCheck`;
  renderDrug(label);
}

function backLink() {
  return el("a", { class: "back", href: lastSearchHash || "#/" },
    lastSearchHash ? "← Back to results" : "← New search");
}

function renderDrug(label) {
  const generic = label.generic && label.generic !== "Unknown" ? label.generic : null;
  const subtitle = [sentenceCase(generic), typeName(label.type), (label.route || "").toLowerCase()]
    .filter((part) => part && part !== "unknown")
    .join(" · ");

  const recallStatus = el("div", { class: "recall-status" },
    el("span", { class: "dot" }), "Checking recalls…");
  const sideEffects = el("div", {}, loadingLine("Loading…"));
  const more = el("div", { class: "more", hidden: "" });
  const moreButton = el("button", { class: "more-toggle", type: "button", "aria-expanded": "false" },
    el("span", { text: "See all side effects and recall history" }),
    el("span", { "aria-hidden": "true", text: "›" }));

  moreButton.addEventListener("click", () => {
    const opening = more.hidden;
    more.hidden = !opening;
    moreButton.setAttribute("aria-expanded", String(opening));
    if (opening && !more.dataset.loaded) {
      more.dataset.loaded = "yes";
      renderMore(more, generic);
    }
  });

  drugView.replaceChildren(
    backLink(),
    el("h1", { text: niceName(label.brand) }),
    el("p", { class: "lead", text: subtitle }),
    recallStatus,
    label.boxed_warning && el("div", { class: "boxed" },
      el("h2", { text: "Serious warning" }), readMore(label.boxed_warning)),
    block("What it's for", label.uses || label.purpose),
    block("How to take it", label.dosage),
    block("Do not take if", label.do_not_use),
    block("Warnings", label.warnings),
    block("Pregnancy and breastfeeding", label.pregnancy),
    el("section", { class: "block" },
      el("h2", { text: "Most reported side effects" }), sideEffects),
    moreButton,
    more,
    el("p", { class: "source", text: sourceLine(label) }),
  );

  if (!generic) {
    recallStatus.replaceChildren(el("span", { class: "dot" }), "Recall information is not available for this medicine.");
    sideEffects.replaceChildren(el("p", { text: "No side effect data available for this medicine." }));
    return;
  }

  loadRecallStatus(recallStatus, generic);
  loadTopSideEffects(sideEffects, generic);
}

function sourceLine(label) {
  const parts = ["Information from the official FDA label"];
  if (label.manufacturer && label.manufacturer !== "Unknown") parts.push(`by ${label.manufacturer}`);
  if (label.updated) parts.push(`last updated ${label.updated}`);
  return parts.join(", ") + ".";
}

// One section of the label: a heading and shortened text with "Show more".
function block(title, text) {
  if (!text) return null;
  return el("section", { class: "block" }, el("h2", { text: title }), readMore(text));
}

function readMore(rawText) {
  const text = capitalize(rawText);
  const short = shorten(text);
  const paragraph = el("p", { text: short });
  if (short === text) return paragraph;

  let expanded = false;
  const button = el("button", { class: "link-button", type: "button" }, "Show more");
  button.addEventListener("click", () => {
    expanded = !expanded;
    paragraph.textContent = expanded ? text : short;
    button.textContent = expanded ? "Show less" : "Show more";
  });
  return el("div", {}, paragraph, button);
}

async function loadRecallStatus(box, generic) {
  try {
    const data = await api(`/api/recalls?${new URLSearchParams({ name: generic })}`);
    const who = `medicines containing ${generic.toLowerCase()}`;
    if (data.ongoing > 0) {
      box.className = "recall-status bad";
      box.replaceChildren(el("span", { class: "dot" }),
        `${plural(data.ongoing, "ongoing recall")} for ${who}. Check the recall history below.`);
    } else if (data.count > 0) {
      box.className = "recall-status ok";
      box.replaceChildren(el("span", { class: "dot" }),
        `No ongoing recalls (${plural(data.count, "past recall")} for ${who}).`);
    } else {
      box.className = "recall-status ok";
      box.replaceChildren(el("span", { class: "dot" }), "No recalls on record.");
    }
  } catch (err) {
    box.className = "recall-status";
    box.replaceChildren(el("span", { class: "dot" }), `Couldn't check recalls: ${err.message}`);
  }
}

async function loadTopSideEffects(box, generic) {
  try {
    const data = await api(`/api/side-effects?${new URLSearchParams({ name: generic })}`);
    if (data.count === 0) {
      box.replaceChildren(el("p", { text: "No side effect reports found." }));
      return;
    }
    box.replaceChildren(
      el("ul", {}, ...data.results.slice(0, 5).map((e) => el("li", { text: e.reaction }))),
      el("p", { class: "note", text: "Based on reports sent to the FDA. A report does not prove the medicine caused it." }),
    );
  } catch (err) {
    box.replaceChildren(errorBox(err.message, () => loadTopSideEffects(box, generic)));
  }
}


// -------------------------------------------- "See all" section (details)

function renderMore(container, generic) {
  if (!generic) {
    container.replaceChildren(el("p", { text: "No side effect or recall data is available for this medicine." }));
    return;
  }

  // Side effects chart with an "All reports / Serious only" toggle.
  const chart = el("div");
  const toggle = el("div", { class: "toggle", role: "group", "aria-label": "Which reports" });
  [["All reports", false], ["Serious only", true]].forEach(([text, serious]) => {
    toggle.append(el("button", {
      type: "button",
      "aria-pressed": String(!serious),
      onclick: (event) => {
        toggle.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", "false"));
        event.currentTarget.setAttribute("aria-pressed", "true");
        loadChart(chart, generic, serious);
      },
    }, text));
  });

  // Recall list with severity filter and sort order.
  const recallList = el("div");
  const classSelect = el("select", { "aria-label": "Recall severity" },
    el("option", { value: "all" }, "All severities"),
    el("option", { value: "I" }, "Class I (most serious)"),
    el("option", { value: "II" }, "Class II"),
    el("option", { value: "III" }, "Class III (least serious)"));
  const sortRecalls = el("select", { "aria-label": "Sort recalls" },
    el("option", { value: "newest" }, "Newest first"),
    el("option", { value: "oldest" }, "Oldest first"),
    el("option", { value: "severity" }, "Most serious first"));
  const reloadRecalls = () => loadRecallList(recallList, generic, classSelect.value, sortRecalls.value);
  classSelect.addEventListener("change", reloadRecalls);
  sortRecalls.addEventListener("change", reloadRecalls);

  container.replaceChildren(
    el("section", { class: "block" },
      el("div", { class: "row-head" }, el("h2", { text: "Side effects reported to the FDA" }), toggle),
      chart,
      el("p", { class: "note", text: "Number of reports that mention each reaction. A report does not prove the medicine caused it." })),
    el("section", { class: "block" },
      el("div", { class: "row-head" }, el("h2", { text: "Recall history" }),
        el("div", { class: "filters" }, classSelect, sortRecalls)),
      recallList),
  );

  loadChart(chart, generic, false);
  reloadRecalls();
}

async function loadChart(box, generic, serious) {
  box.replaceChildren(loadingLine("Loading…"));
  try {
    const params = new URLSearchParams({ name: generic, serious: String(serious) });
    const data = await api(`/api/side-effects?${params}`);
    if (data.count === 0) {
      box.replaceChildren(el("p", { text: "No reports found." }));
      return;
    }
    const max = Math.max(...data.results.map((e) => e.count));
    box.replaceChildren(...data.results.map((e) =>
      el("div", { class: "bar-row" },
        el("span", { text: e.reaction }),
        el("span", { class: "bar-track", "aria-hidden": "true" },
          el("span", { class: "bar-fill", style: `width: ${((e.count / max) * 100).toFixed(1)}%` })),
        el("span", { class: "bar-value", text: e.count.toLocaleString() }))));
  } catch (err) {
    box.replaceChildren(errorBox(err.message, () => loadChart(box, generic, serious)));
  }
}

async function loadRecallList(box, generic, level, sort) {
  box.replaceChildren(loadingLine("Loading…"));
  try {
    const params = new URLSearchParams({ name: generic, class: level, sort });
    const data = await api(`/api/recalls?${params}`);
    if (data.count === 0) {
      box.replaceChildren(el("p", { text: level === "all" ? "No recalls on record." : "No recalls of this severity." }));
      return;
    }
    const SHOW_FIRST = 8;
    const items = data.results.map((r) =>
      el("li", {},
        el("div", { class: "meta" },
          el("span", { text: r.date }),
          el("span", { class: r.classification === "Class I" ? "badge class-1" : "badge", text: r.classification }),
          el("span", { class: r.status === "Ongoing" ? "badge ongoing" : "badge", text: r.status })),
        el("p", { text: shorten(r.reason, 220) })));

    // Long lists: show the first few, with a button to show the rest.
    items.slice(SHOW_FIRST).forEach((item) => { item.hidden = true; });
    const showAll = items.length > SHOW_FIRST && el("button", {
      class: "link-button", type: "button",
      onclick: (event) => {
        items.forEach((item) => { item.hidden = false; });
        event.currentTarget.remove();
      },
    }, `Show all ${data.count} recalls`);

    box.replaceChildren(el("ul", { class: "recalls" }, ...items), showAll);
  } catch (err) {
    box.replaceChildren(errorBox(err.message, () => loadRecallList(box, generic, level, sort)));
  }
}


// --------------------------------------------------------------- events

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const q = input.value.trim();
  if (!VALID_QUERY.test(q)) {
    formError.textContent = "Please type 2 to 50 letters, numbers or spaces.";
    formError.hidden = false;
    input.focus();
    return;
  }
  go(searchHash(q, current.q ? current.type : "all", current.q ? current.sort : "name"));
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => go(searchHash(current.q, chip.dataset.type, current.sort)));
});

sortSelect.addEventListener("change", () => go(searchHash(current.q, current.type, sortSelect.value)));

window.addEventListener("hashchange", route);

// Footer: which server answered (shows the load balancer at work).
api("/api/health")
  .then((data) => { $("#served-by").textContent = `Served by ${data.server}`; })
  .catch(() => {});

route();
