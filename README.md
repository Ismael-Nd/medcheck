# MedCheck

A simple web app to look up a medicine and see, in plain language, **what it's for, how to take it, its warnings, reported side effects, and recall history**. Data comes from the U.S. FDA's **openFDA API**.

**Live:** https://medcheck.ismaelnd.tech · **Demo video:** (https://www.loom.com/share/56d4a1d313a44b35b238050ddc4faf29)

> Information only, not medical advice.

## Features
- **Search** by brand or generic name (*paracetamol* is translated to *acetaminophen* automatically)
- **Filter** by Over the counter / Prescription, recalls by Class I–III, side effects by "serious only"
- **Sort** results by name, last updated or manufacturer, and recalls by date or severity
- **Error handling**: clear messages for bad input, no results, a slow API or rate limits, with a *Try again* button

## Tech
Python (Flask) backend · HTML/CSS/JS frontend · Gunicorn + Nginx on 2 web servers · HAProxy load balancer with HTTPS (Let's Encrypt)

The browser only calls MedCheck's own `/api/...` routes, and Flask calls openFDA. **The API key stays on the server** in a `.env` file that is never committed.

## Run locally
```bash
git clone https://github.com/Ismael-Nd/medcheck.git && cd medcheck
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # add your key: OPENFDA_API_KEY=...
flask --app app run         # open http://127.0.0.1:5000
```
Get a free key at https://open.fda.gov/apis/authentication/ (the app also works without one, with lower limits).

## Deployment
```
User → Lb01 (HAProxy, HTTPS, round-robin) → Web01 / Web02 (Nginx → Gunicorn → Flask) → openFDA
```
**Web01 and Web02:** clone the repo, create the venv, and add `.env` with `SERVER_NAME=web-01` (or `web-02`). Then:
```bash
sudo cp deploy/medcheck.service /etc/systemd/system/
sudo systemctl enable --now medcheck
sudo cp deploy/nginx-medcheck.conf /etc/nginx/sites-available/medcheck
sudo ln -s /etc/nginx/sites-available/medcheck /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default && sudo systemctl reload nginx
```
**Lb01:** get a certificate with `certbot certonly --standalone -d medcheck.ismaelnd.tech`, combine `fullchain.pem` + `privkey.pem` into `/etc/haproxy/certs/medcheck.pem`, use `deploy/haproxy.cfg`, and restart HAProxy.

**Test the load balancing:**
```bash
for i in 1 2 3 4; do curl -s https://medcheck.ismaelnd.tech/api/health; echo; done
# {"server":"web-01",...}  {"server":"web-02",...}  alternating
```

## Challenges
- **openFDA returns 404 for "no results"**, so I treat it as an empty list instead of an error.
- **openFDA is sometimes slow or fails**, so I added a timeout, a retry and a 1-hour cache.
- **Nginx hung silently**: `proxy_pass https://` should have been `http://`, because Gunicorn speaks plain HTTP.
- **Old configs from earlier projects** on Web02 and Lb01 sent traffic to the wrong place, so I replaced them.
- **I almost committed `.env`**: I removed it before pushing and added `.gitignore`.

## Credits
Data: [openFDA](https://open.fda.gov), U.S. Food and Drug Administration (drug labels, adverse events, recalls). Side-effect counts are **reports**, not proof the medicine caused them.
