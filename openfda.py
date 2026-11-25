# All communication with the openFDA API lives in this file.
# openFDA docs: https://open.fda.gov/apis/drug/

import os
import re
import time
import json
import hashlib
import tempfile
import time

import requests

BASE_URL = "https://api.fda.gov/drug"
TIMEOUT = 15           # seconds: never wait forever for openFDA
RETRIES = 2            # openFDA is sometimes flaky, so try twice
CACHE_TTL = 60 * 60    # keep answers for 1 hour
CACHE_DIR = os.path.join(tempfile.gettempdir(), "medcheck-cache")

# Reaction terms that are not real side effects, hidden from the chart.
NOT_SIDE_EFFECTS = {
    "DRUG INEFFECTIVE",
    "OFF LABEL USE",
    "PRODUCT USE IN UNAPPROVED INDICATION",
    "PRODUCT USE ISSUE",
    "DRUG INTERACTION",
    "NO ADVERSE EVENT",
    "PRODUCT DOSE OMISSION ISSUE",
    "INAPPROPRIATE SCHEDULE OF PRODUCT ADMINISTRATION",
    "INCORRECT DOSE ADMINISTERED",
    "WRONG TECHNIQUE IN PRODUCT USAGE PROCESS",
    "TOXICITY TO VARIOUS AGENTS",
    "INTENTIONAL OVERDOSE",
    "INTENTIONAL PRODUCT MISUSE",
    "DRUG ABUSE",
    "COMPLETED SUICIDE",
    "DEATH",
}

# The cache is stored as small files on disk instead of in memory.
# Gunicorn runs several worker processes and each has its own memory,
# so an in-memory cache was only shared by 1 worker. Files are shared by all of them.
def _cache_path(endpoint, params):
    key = endpoint + "?" + json.dumps(params, sort_keys=True)
    return os.path.join(CACHE_DIR, hashlib.sha256(key.encode()).hexdigest() + ".json")

# Returns (True, data) if a fresh answer is cached, otherwise (False, None).
def _cache_read(path):
    try:
        if time.time() - os.path.getmtime(path) < CACHE_TTL:
            with open(path, encoding="utf-8") as f:
                return True, json.load(f)
    except (OSError, ValueError):
        pass                              # missing or broken file: treat as not cached
    return False, None

# Writes to a temporary file first, then renames it, so another worker
# never reads a half-written file.
def _cache_write(path, data):
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, path)
    except OSError:
        pass                              # caching is optional: never crash because of it



# Raised when openFDA is down, slow, rate-limited or returns an error.
class OpenFDAError(Exception):
    pass


# ---------------------------------------------------------------- helpers

# Return the first item of data[key], or default if it's missing.
# openFDA stores almost every field as a list, and some labels are
# missing fields entirely, so this keeps one bad label from crashing us.
def first(data, key, default="Unknown"):
    values = data.get(key)
    return values[0] if values else default


# Labels repeat their own heading at the start of each section,
# e.g. "Uses temporarily relieves..." or "1 INDICATIONS AND USAGE ...".
HEADING = re.compile(
    r"^\s*[\d.]*\s*(warnings and precautions|purposes?|uses|directions|"
    r"warnings?|do not use|"
    r"active ingredients?( \([^)]*\))?|indications (and|&) usage|"
    r"dosage (and|&) administration|contraindications|adverse reactions|"
    r"boxed warning)\s*[:.]?\s*",
    re.IGNORECASE,
)


# Join a label section (a list of paragraphs) into one clean string.
def text(item, key):
    joined = " ".join(item.get(key, [])).strip()
    return HEADING.sub("", joined, count=1)


# Turn '20180110' into '2018-01-10'.
def format_date(raw):
    if raw and len(raw) == 8:
        return f"{raw[:4]}-{raw[4:6]}-{raw[6:]}"
    return raw or ""


# GET an openFDA endpoint with caching and error handling.
# Returns the parsed JSON, or None when openFDA finds no matches (404).
# Raises OpenFDAError for every other problem.
def _get(endpoint, params):
    cache_path = _cache_path(endpoint, params)
    found, data = _cache_read(cache_path)
    if found:
        return data

    query = dict(params)
    api_key = os.getenv("OPENFDA_API_KEY")
    if api_key:
        query["api_key"] = api_key

    response = None
    for _attempt in range(RETRIES):
        try:
            response = requests.get(f"{BASE_URL}/{endpoint}.json",
                                    params=query, timeout=TIMEOUT)
        except requests.exceptions.RequestException:
            response = None              # network problem: try again
            continue
        if response.status_code < 500:  # 5xx = openFDA hiccup: try again
            break
    if response is None:
        raise OpenFDAError("Could not reach openFDA")

    if response.status_code == 404:
        data = None                      # no matches: not an error
    elif response.status_code == 429:
        raise OpenFDAError("Too many requests to openFDA, try again shortly")
    elif response.status_code != 200:
        raise OpenFDAError(f"openFDA returned {response.status_code}")
    else:
        try:
            data = response.json()
        except ValueError as err:
            raise OpenFDAError("openFDA sent an invalid response") from err

    _cache_write(cache_path, data)
    return data


# ---------------------------------------------------------- public functions

# Search medicines by brand or generic name.
# Returns a list of small dicts, one per medicine (duplicates removed).
def search_labels(query, limit=50):
    search = f'openfda.brand_name:"{query}" OR openfda.generic_name:"{query}"'
    data = _get("label", {"search": search, "limit": limit})
    if not data:
        return []

    results, seen = [], set()
    for item in data.get("results", []):
        info = item.get("openfda", {})
        brand = first(info, "brand_name")
        manufacturer = first(info, "manufacturer_name")

        key = (brand.lower(), manufacturer.lower())
        if key in seen:                  # same product, different label version
            continue
        seen.add(key)

        product_type = first(info, "product_type", "")
        results.append({
            "id": item.get("set_id"),
            "brand": brand,
            "generic": first(info, "generic_name"),
            "manufacturer": manufacturer,
            "route": first(info, "route"),
            "type": "OTC" if "OTC" in product_type else "Rx",
            "updated": format_date(item.get("effective_time")),
        })
    return results


# Return the full label of one medicine, or None if it doesn't exist.
def get_label(set_id):
    data = _get("label", {"search": f'set_id:"{set_id}"', "limit": 1})
    if not data or not data.get("results"):
        return None

    item = data["results"][0]
    info = item.get("openfda", {})
    product_type = first(info, "product_type", "")
    return {
        "id": item.get("set_id"),
        "brand": first(info, "brand_name"),
        "generic": first(info, "generic_name"),
        "manufacturer": first(info, "manufacturer_name"),
        "route": first(info, "route"),
        "type": "OTC" if "OTC" in product_type else "Rx",
        "updated": format_date(item.get("effective_time")),
        # OTC labels and prescription labels use different section names,
        # so each field falls back to the prescription equivalent.
        "purpose": text(item, "purpose"),
        "uses": text(item, "indications_and_usage"),
        "dosage": text(item, "dosage_and_administration"),
        "active_ingredient": text(item, "active_ingredient"),
        "boxed_warning": text(item, "boxed_warning"),
        "do_not_use": text(item, "do_not_use") or text(item, "contraindications"),
        "warnings": text(item, "warnings") or text(item, "warnings_and_cautions"),
        "pregnancy": (text(item, "pregnancy_or_breast_feeding")
                      or text(item, "pregnancy")),
        "side_effects_label": text(item, "adverse_reactions"),
    }


# Top reported reactions for a medicine from FDA adverse event reports.
# Returns a list like [{"reaction": "Nausea", "count": 18573}, ...].
def get_side_effects(generic_name, serious_only=False, limit=10):
    search = f'patient.drug.openfda.generic_name:"{generic_name}"'
    if serious_only:
        search += " AND serious:1"

    data = _get("event", {
        "search": search,
        "count": "patient.reaction.reactionmeddrapt.exact",
        "limit": 40,                     # extra, because some get filtered out
    })
    if not data:
        return []

    effects = []
    for row in data.get("results", []):
        term = row.get("term", "")
        if term.upper() in NOT_SIDE_EFFECTS:
            continue
        effects.append({"reaction": term.capitalize(), "count": row.get("count", 0)})
        if len(effects) == limit:
            break
    return effects


# Recalls (FDA enforcement reports) for a medicine, newest first.
def get_recalls(generic_name, limit=100):
    data = _get("enforcement", {
        "search": f'openfda.generic_name:"{generic_name}"',
        "limit": limit,
    })
    if not data:
        return []

    recalls = []
    for item in data.get("results", []):
        recalls.append({
            "date": format_date(item.get("recall_initiation_date")),
            "classification": item.get("classification", "Unknown"),
            "status": item.get("status", "Unknown"),
            "reason": item.get("reason_for_recall", "").strip(),
            "product": item.get("product_description", "").strip(),
            "company": item.get("recalling_firm", "Unknown"),
        })
    recalls.sort(key=lambda r: r["date"], reverse=True)
    return recalls
