# Deploying (Azure App Service, via GitHub Student Developer Pack)

This app needs a long-running Node process with **persistent storage**: the SQLite
file has to survive restarts and redeploys, which rules out serverless hosts
(Vercel/Netlify) as-is. Azure was chosen specifically because **Azure for Students**
(available through the GitHub Student Developer Pack) grants Azure credit **without
requiring a credit card**, unlike Fly.io, Oracle Cloud, or standard Azure signup.
Azure App Service (Linux) also has a real advantage here: every Linux App Service
plan automatically persists its `/home` directory across restarts and redeploys, so
there's no separate volume/disk to create and mount (unlike Render or Fly). Just
point `DB_PATH` at a subfolder under `/home`.

1. Activate the **Azure for Students** offer (via the GitHub Student Developer Pack
   or education.github.com). Verify with your school email; no payment method
   needed.
2. In the Azure Portal, create a **Web App**: Linux, Node 20 LTS runtime, region near
   you. **Use the Basic (B1) plan, not the Free (F1) tier**: F1 can't use custom
   domains and sleeps after ~20 minutes idle; B1 costs a few dollars a month,
   comfortably covered by the $100 credit, and supports "Always On" (no sleep) plus
   custom domains with a free Azure-managed TLS certificate.
3. In the app's **Configuration → Application settings**, add:
   `GOOGLE_MAPS_BROWSER_KEY`, `GOOGLE_MAPS_MAP_ID`, `GOOGLE_PLACES_SERVER_KEY`,
   `ANTHROPIC_API_KEY`, `NODE_ENV=production`, and
   `DB_PATH=/home/data/foodfindr.db` (Azure supplies `PORT` itself).
4. Turn on **Always On** under Configuration → General settings (only available on
   Basic tier and up).
5. **Deployment Center** → connect this GitHub repo → Azure sets up a GitHub Actions
   workflow that builds and deploys automatically on every push to `main`.
6. Once deployed, verify on the `*.azurewebsites.net` URL Azure gives you: sign up,
   log a visit, **restart the Web App from the Portal, and confirm the visit is
   still there** (the real test that `/home` persistence is working).
7. In Google Cloud Console, add the `azurewebsites.net` URL to the Maps browser
   key's allowed HTTP referrers (it's referrer-restricted).
8. Only once that's all verified working: attach a custom domain, either the free
   Namecheap `.me` domain from the Student Pack, or one you already own. Add the DNS
   records Azure's **Custom domains** blade provides at your registrar (a `TXT`
   record for verification, then a `CNAME` for `www` or an `A` record at the apex).
   Azure then issues a free managed certificate automatically once DNS resolves. No
   registrar credentials ever need to leave your own hands.

The app is live at [foodfindr.tech](https://foodfindr.tech), on the Basic (B1) plan
with a free Azure-managed certificate. Helmet's `contentSecurityPolicy` is enabled
with a host-based allowlist scoped to Google's Maps/Fonts domains (see
`server/server.js`), and the Maps browser key's referrer allowlist includes the
custom domain.
