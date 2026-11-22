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
const sta