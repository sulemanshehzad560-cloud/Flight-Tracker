package com.flighttracker.app;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.ConsoleMessage;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Hosts the Flight Tracker web app in a WebView, with an AdMob banner underneath.
 *
 * - The app's files (assets/www) are served from https://appassets.androidplatform.net/, so ES modules
 *   and browser storage work exactly as on the web.
 * - NativeHttp lets the page make HTTPS requests in native code. The flight-data APIs don't send CORS
 *   headers, so the WebView's own fetch() could not read them (the web version uses server.js for this).
 * - NativeApp gives the page diagnostics (error logging, report sharing) and ad privacy options.
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/public/index.html";
    private static final int LOCATION_REQUEST = 1;

    private WebView web;
    private FrameLayout webHolder;
    private AdsController ads;
    private final ExecutorService pool = Executors.newFixedThreadPool(6);
    private GeolocationPermissions.Callback pendingGeoCallback;
    private String pendingGeoOrigin;
    private boolean offerCrashReport;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        offerCrashReport = Diagnostics.consumeCrashFlag();
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(0xFF0B1020);
        webHolder = new FrameLayout(this);
        root.addView(webHolder, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        FrameLayout adContainer = new FrameLayout(this);
        adContainer.setVisibility(View.GONE);
        LinearLayout.LayoutParams adParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        adParams.gravity = Gravity.CENTER_HORIZONTAL;
        root.addView(adContainer, adParams);
        setContentView(root);
        applyEdgeToEdge(root);

        if (!createWebView(savedInstanceState)) return;

        ads = new AdsController(this, adContainer);
        ads.start();
    }

    /** Draw behind the system bars (mandatory from Android 15) and pad the content so nothing is hidden. */
    @SuppressWarnings("deprecation")
    private void applyEdgeToEdge(View root) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
        } else {
            root.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                Insets ime = insets.getInsets(WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            } else {
                v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
    }

    /** Returns false when no usable WebView is installed (the app then shows a message instead of crashing). */
    private boolean createWebView(Bundle savedInstanceState) {
        try {
            web = new WebView(this);
        } catch (RuntimeException e) {
            Diagnostics.log("E", "WebView", "Unavailable: " + Diagnostics.stackTrace(e));
            TextView message = new TextView(this);
            message.setText("Flight Tracker needs Android System WebView. Please install or update it from the Play Store, then reopen the app.");
            message.setTextColor(0xFFE8ECF5);
            message.setPadding(48, 48, 48, 48);
            webHolder.addView(message);
            return false;
        }
        web.setBackgroundColor(0xFF0B1020);
        webHolder.addView(web, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setGeolocationEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " FlightTrackerApp/" + BuildConfig.VERSION_NAME);

        web.addJavascriptInterface(new NativeHttp(), "NativeHttp");
        web.addJavascriptInterface(new NativeApp(), "NativeApp");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                return HOST.equals(url.getHost()) ? serveAsset(url.getPath()) : null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return openExternally(request.getUrl());
            }

            @SuppressWarnings("deprecation")
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return openExternally(Uri.parse(url)); // Android 6 only calls this variant
            }

            private boolean openExternally(Uri url) {
                if (HOST.equals(url.getHost())) return false;
                // Links to other sites (photo credits etc.) open in the browser.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (ActivityNotFoundException ignored) {
                    // no browser installed
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (offerCrashReport) {
                    offerCrashReport = false;
                    view.evaluateJavascript("window.flightTracker && window.flightTracker.onPreviousCrash && window.flightTracker.onPreviousCrash()", null);
                }
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // The web page's process crashed or was killed for memory: rebuild instead of crashing the app.
                Diagnostics.log("E", "WebView", "Renderer gone (crashed=" + detail.didCrash()
                    + ", priority=" + detail.rendererPriorityAtExit() + ")");
                webHolder.removeView(view);
                view.destroy();
                web = null;
                recreate();
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (hasLocationPermission()) {
                    callback.invoke(origin, true, false);
                } else {
                    pendingGeoOrigin = origin;
                    pendingGeoCallback = callback;
                    requestPermissions(new String[] {
                        Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION,
                    }, LOCATION_REQUEST);
                }
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    Diagnostics.log("E", "JS", message.message() + " (" + message.sourceId() + ":" + message.lineNumber() + ")");
                }
                return true;
            }
        });

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(START_URL);
        return true;
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == LOCATION_REQUEST && pendingGeoCallback != null) {
            pendingGeoCallback.invoke(pendingGeoOrigin, hasLocationPermission(), false);
            pendingGeoCallback = null;
        }
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (web == null) {
            super.onBackPressed();
            return;
        }
        // Let the app close search / panels / the selected flight first.
        web.evaluateJavascript("!!(window.flightTracker && window.flightTracker.back())", handled -> {
            if (!"true".equals(handled)) finish();
        });
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (web != null) web.saveState(outState);
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        if (ads != null) ads.pause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        if (ads != null) ads.resume();
    }

    @Override
    protected void onDestroy() {
        pool.shutdownNow();
        if (ads != null) ads.destroy();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    // ------------------------------------------------------------------ bundled web app

    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html");
        MIME.put("js", "text/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("svg", "image/svg+xml");
        MIME.put("png", "image/png");
    }

    private WebResourceResponse serveAsset(String path) {
        if (path == null || path.equals("/")) path = "/public/index.html";
        String ext = path.substring(path.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
        String mime = MIME.containsKey(ext) ? MIME.get(ext) : "application/octet-stream";
        try {
            InputStream in = getAssets().open("www" + path);
            return new WebResourceResponse(mime, "UTF-8", in);
        } catch (IOException e) {
            Diagnostics.log("W", "Assets", "Missing " + path);
            WebResourceResponse notFound = new WebResourceResponse("text/plain", "UTF-8",
                new ByteArrayInputStream(new byte[0]));
            notFound.setStatusCodeAndReasonPhrase(404, "Not Found");
            return notFound;
        }
    }

    // ------------------------------------------------------------------ bridges for the page

    /** Native HTTPS for the page (not subject to CORS). */
    private class NativeHttp {
        @JavascriptInterface
        public void request(String id, String method, String url, String headersJson, String body) {
            pool.execute(() -> {
                int status = 0;
                String text = "";
                String error = null;
                JSONObject responseHeaders = new JSONObject();
                HttpURLConnection conn = null;
                try {
                    URL target = new URL(url);
                    if (!"https".equals(target.getProtocol())) throw new IOException("Only HTTPS is allowed");
                    conn = (HttpURLConnection) target.openConnection();
                    conn.setConnectTimeout(10000);
                    conn.setReadTimeout(30000);
                    conn.setRequestMethod(method);
                    JSONObject headers = new JSONObject(headersJson);
                    Iterator<String> keys = headers.keys();
                    while (keys.hasNext()) {
                        String key = keys.next();
                        conn.setRequestProperty(key, headers.getString(key));
                    }
                    if (!body.isEmpty() && !"GET".equals(method)) {
                        conn.setDoOutput(true);
                        try (OutputStream out = conn.getOutputStream()) {
                            out.write(body.getBytes(StandardCharsets.UTF_8));
                        }
                    }
                    status = conn.getResponseCode();
                    for (Map.Entry<String, List<String>> h : conn.getHeaderFields().entrySet()) {
                        if (h.getKey() != null && !h.getValue().isEmpty()) {
                            responseHeaders.put(h.getKey().toLowerCase(Locale.ROOT), h.getValue().get(0));
                        }
                    }
                    InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                    text = in == null ? "" : readAll(in);
                } catch (Exception e) {
                    error = e.getClass().getSimpleName() + ": " + e.getMessage();
                } finally {
                    if (conn != null) conn.disconnect();
                }
                String js = "window.__nativeHttpDone(" + JSONObject.quote(id) + "," + status + ","
                    + JSONObject.quote(responseHeaders.toString()) + "," + JSONObject.quote(text) + ","
                    + (error == null ? "null" : JSONObject.quote(error)) + ")";
                runOnUiThread(() -> {
                    if (web != null) web.evaluateJavascript(js, null);
                });
            });
        }
    }

    /** App-level features for the page: diagnostics and ad privacy options. */
    private class NativeApp {
        @JavascriptInterface
        public void log(String level, String message) {
            Diagnostics.log(level, "JS", message);
        }

        @JavascriptInterface
        public void shareDiagnostics() {
            runOnUiThread(() -> Diagnostics.share(MainActivity.this));
        }

        @JavascriptInterface
        public boolean isPrivacyOptionsRequired() {
            return ads != null && ads.isPrivacyOptionsRequired();
        }

        @JavascriptInterface
        public void showPrivacyOptions() {
            runOnUiThread(() -> {
                if (ads != null) ads.showPrivacyOptions();
            });
        }

        @JavascriptInterface
        public String version() {
            return BuildConfig.VERSION_NAME + " (" + BuildConfig.VERSION_CODE + ")";
        }
    }

    private static String readAll(InputStream in) throws IOException {
        try (InputStream input = in; ByteArrayOutputStream buf = new ByteArrayOutputStream()) {
            byte[] chunk = new byte[16384];
            int n;
            while ((n = input.read(chunk)) != -1) buf.write(chunk, 0, n);
            return buf.toString("UTF-8");
        }
    }
}
