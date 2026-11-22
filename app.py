# MedCheck: Flask backend.
# so the API key stays on the server and never reaches the browser.

import os
import re

from dotenv import load_dotenv
from flask import Flask, jsonify, request

from openfda import (OpenFDAError, get_label, get_recalls, get_side_effects,
                     search_labels)

load_dotenv()  # reads your .env file (API key, server name)

app = Flask(__name__, static_folder="static", static_url_path="")
SERVER_NAME = os.getenv("SERVER_NAME", "unknown")

# What users may type in the search box: 2-50 letters, numbers, spaces, hyphens.
# Blocks junk input and stops people injecting openFDA query syntax.
VALID_QUERY = re.compile(r"^[A-Za-z0-9 \-]{2,50}$")

# Generic names can also contain commas, dots, slashes and brackets,
# e.g. "ACETAMINOPHEN, DEXTROMETHORPHAN HBR". Still no quotes or colons.
VALID_NAME = re.compile(r"^[A-Za-z0-9 ,.\-/()]{2,150}$")

# A label id (set_id) looks like 00653b7c-7099-487e-9a01-e89781c21323.
VALID_ID = re.compile(r"^[a-fA-F0-9\-]{36}$")

# Recall classes, ordered from most to least serious (used for sorting).
CLASS_ORDER = {"Class I": 1, "Class II": 2, "Class III": 3}

DATABASE_DOWN = "The medicine database is not responding. Please try again in a minute."


# Small helper so every error has the same JSON shape: {"error": "..."}
def error(message, status):
    return jsonify({"error": message}), status


# ------------------------------------------------------------------ pages

# The frontend (static/index.html). Until it exists, show a simple message.
@app.route("/")
def home():
    if os.path.exists(os.path.join(app.static_folder, "index.html")):
        return app.send_static_file("index.html")
    return "MedCheck API is running"


# Used to check the server is alive and which server answered.
@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "server": SERVER_NAME})


# -------------------------------------------------------------------- API

# Search medicines: /api/search?q=ibuprofen&type=otc&sort=name
#   type: all (default), otc, rx
#   sort: name (default), updated, manufacturer
@app.route("/api/search")
def search():
    q = request.args.get("q", "").strip()
    kind = request.args.get("type", "all").lower()
    sort = request.args.get("sort", "name").lower()

    if not VALID_QUERY.match(q):
        return error("Please enter 2 to 50 letters, numbers or spaces.", 400)
    if kind not in ("all", "otc", "rx"):
        return error("type must be all, otc or rx.", 400)
    if sort not in ("name", "updated", "manufacturer"):
        return error("sort must be name, updated or manufacturer.", 400)

    try:
        results = search_labels(q)
    except OpenFDAError:
        return error(DATABASE_DOWN, 503)

    if kind != "all":
        results = [r for r in results if r["type"].lower() == kind]

    if sort == "updated":
        results.sort(key=lambda r: r["updated"], reverse=True)   # newest first
    elif sort == "manufacturer":
        results.sort(key=lambda r: r["manufacturer"].lower())
    else:
        results.sort(key=lambda r: r["brand"].lower())

    return jsonify({"query": q, "count": len(results), "results": results})


# Full details of one medicine: /api/drug/<set_id>
@app.route("/api/drug/<set_id>")
def drug(set_id):
    if not VALID_ID.match(set_id):
        return error("That medicine id is not valid.", 400)

    try:
        label = get_label(set_id)
    except OpenFDAError:
        return error(DATABASE_DOWN, 503)

    if label is None:
        return error("We could not find that medicine.", 404)
    return jsonify(label)


# Most reported side effects: /api/side-effects?name=ibuprofen&serious=true
@app.route("/api/side-effects")
def side_effects():
    name = request.args.get("name", "").strip()
    serious = request.args.get("serious", "false").lower() == "true"

    if not VALID_NAME.match(name):
        return error("Please give a valid medicine name.", 400)

    try:
        effects = get_side_effects(name, serious_only=serious)
    except OpenFDAError:
        return error(DATABASE_DOWN, 503)

    return jsonify({"name": name, "serious_only": serious,
                    "count": len(effects), "results": effects})


# Recalls: /api/recalls?name=ibuprofen&class=all&sort=newest
#   class: all (default), I, II, III
#   sort:  newest (default), oldest, severity
@app.route("/api/recalls")
def recalls():
    name = request.args.get("name", "").strip()
    level = request.args.get("class", "all").upper()
    sort = request.args.get("sort", "newest").lower()

    if not VALID_NAME.match(name):
        return error("Please give a valid medicine name.", 400)
    if level not in ("ALL", "I", "II", "III"):
        return error("class must be all, I, II or III.", 400)
    if sort not in ("newest", "oldest", "severity"):
        return error("sort must be newest, oldest or severity.", 400)

    try:
        results = get_recalls(name)
    except OpenFDAError:
        return error(DATABASE_DOWN, 503)

    if level != "ALL":
        results = [r for r in results if r["classification"] == f"Class {level}"]

    if sort == "oldest":
        results.sort(key=lambda r: r["date"])
    elif sort == "severity":
        results.sort(key=lambda r: (CLASS_ORDER.get(r["classification"], 9),
                                    r["date"]))
    # "newest" is already the order get_recalls returns

    ongoing = sum(1 for r in results if r["status"] == "Ongoing")
    return jsonify({"name": name, "count": len(results),
                    "ongoing": ongoing, "results": results})


# ------------------------------------------------------------ error pages

# Unknown URL: answer with JSON instead of Flask's HTML error page.
@app.errorhandler(404)
def not_found(_error):
    return error("Not found.", 404)


# Unexpected crash: hide the technical details from the user.
@app.errorhandler(500)
def server_error(_error):
    return error("Something went wrong on our side.", 500)


# Tag every response with the server name (proves load balancing works).
@app.after_request
def add_server_header(response):
    response.headers["X-Served-By"] = SERVER_NAME
    return response
