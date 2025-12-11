# Browser Cache Issue - How to Fix

## Problem
The terminal dashboard nginx config caches JavaScript/CSS assets for 1 year:

```nginx
location /assets/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
}
```

This is good for production performance, but after rebuilding the dashboard, browsers will serve the old cached JavaScript instead of fetching the new version.

## Solution: Hard Refresh

### Windows/Linux:
- **Ctrl + Shift + R** (Chrome, Firefox, Edge)
- Or **Ctrl + F5**

### Mac:
- **Cmd + Shift + R** (Chrome, Firefox)
- Or **Cmd + Option + R** (Safari)

### Alternative: Clear Cache
1. Open browser DevTools (F12)
2. Right-click the refresh button
3. Select "Empty Cache and Hard Reload"

## Verification

After hard refresh, check browser DevTools:
1. Press F12 to open DevTools
2. Go to Network tab
3. Refresh the page
4. Look for `index-Bi8oziri.js` (current bundle)
5. Check the Status column - should show `200` not `304 (cached)`

## Why This Happens

1. Dashboard was rebuilt → new JavaScript bundle created: `index-Bi8oziri.js`
2. Browser has old bundle cached: might be `index-ABC123.js` (old hash)
3. HTML page (`index.html`) updated to reference `index-Bi8oziri.js`
4. But browser might also cache the HTML page itself
5. Hard refresh forces browser to:
   - Re-fetch the HTML
   - See the new bundle filename
   - Download the new JavaScript

## Development vs Production

**Current config (development):**
- Cache duration: 1 year
- Good for: Production performance
- Bad for: Rapid development iteration

**Optional: Disable caching for development:**

Edit `terminal-dashboard/nginx.conf`:
```nginx
# DEVELOPMENT ONLY - disable asset caching
location /assets/ {
    expires -1;
    add_header Cache-Control "no-store, no-cache, must-revalidate";
}
```

Then rebuild: `docker-compose build terminal-dashboard && docker-compose up -d terminal-dashboard`

## Current Bundle Verification

```bash
# Check what bundle is actually in the container
docker exec ai-workflow-dashboard ls -lh /usr/share/nginx/html/assets/

# Should show:
# index-Bi8oziri.js  (530.8K, Dec 11 00:55)
# index-D9D8B2Bk.css (38.7K, Dec 11 00:55)

# Verify Plane components are in the bundle
docker exec ai-workflow-dashboard grep -o "⚡" /usr/share/nginx/html/assets/index-Bi8oziri.js | wc -l

# Should show: 5 (⚡ emoji appears 5 times in the compiled code)
```

---

**Bottom line:** The code is correct and deployed. The browser just needs a hard refresh to see it.
