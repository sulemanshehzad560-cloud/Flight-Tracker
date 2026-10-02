package com.flighttracker.app;

import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * Worldwide ship positions from aisstream.io over a native WebSocket (aisstream refuses browser
 * connections). The page subscribes to the area on screen; messages are handed to the page in
 * batches once a second so the WebView isn't flooded.
 */
final class AisStreamClient extends WebSocketListener {
    private static final String URL = "wss://stream.aisstream.io/v0/stream";
    private static final int MAX_QUEUE = 4000;
    private static final int MAX_BATCH = 1500;

    private final OkHttpClient http = new OkHttpClient.Builder().pingInterval(30, TimeUnit.SECONDS).build();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ConcurrentLinkedQueue<String> queue = new ConcurrentLinkedQueue<>();
    private final AtomicInteger queued = new AtomicInteger();
    private final String apiKey;
    private final WebView web;
    private WebSocket socket;
    private String boxes;
    private boolean running;
    private long retryMs = 2000;
    private long received;
    private int flushes;

    AisStreamClient(String apiKey, WebView web) {
        this.apiKey = apiKey;
        this.web = web;
    }

    static boolean available() {
        return !BuildConfig.AISSTREAM_API_KEY.isEmpty();
    }

    /** boxesJson: [[[south, west], [north, east]], …] */
    synchronized void subscribe(String boxesJson) {
        boxes = boxesJson;
        if (!running) {
            running = true;
            connect();
            main.postDelayed(flush, 1000);
        } else if (socket != null) {
            socket.send(subscription());
        }
    }

    synchronized void close() {
        running = false;
        main.removeCallbacksAndMessages(null);
        if (socket != null) socket.close(1000, null);
        socket = null;
    }

    /** App in background: drop the connection; the next subscribe() (on resume) reconnects. */
    synchronized void pause() {
        if (socket != null) socket.close(1000, "paused");
        socket = null;
        running = false;
        main.removeCallbacksAndMessages(null);
    }

    synchronized void resume() {
        if (boxes != null && !running) subscribe(boxes);
    }

    private String subscription() {
        try {
            JSONObject sub = new JSONObject();
            sub.put("APIKey", apiKey);
            sub.put("BoundingBoxes", new JSONArray(boxes));
            sub.put("FilterMessageTypes", new JSONArray(new String[] {
                "PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport", "ShipStaticData", "StaticDataReport",
            }));
            return sub.toString();
        } catch (Exception e) {
            Diagnostics.log("W", "AIS", "Bad subscription: " + e.getMessage());
            return "{}";
        }
    }

    private synchronized void connect() {
        status("connecting");
        socket = http.newWebSocket(new Request.Builder().url(URL).build(), this);
    }

    @Override
    public void onOpen(WebSocket ws, Response response) {
        Diagnostics.log("I", "AIS", "Connected to aisstream.io");
        retryMs = 2000;
        ws.send(subscription()); // must arrive within 3 seconds
        status("open");
    }

    @Override
    public void onMessage(WebSocket ws, String text) {
        enqueue(text);
    }

    @Override
    public void onMessage(WebSocket ws, ByteString bytes) {
        enqueue(bytes.utf8());
    }

    private void enqueue(String message) {
        received++;
        if (message.startsWith("{\"error\"")) {
            Diagnostics.log("E", "AIS", "aisstream.io: " + message);
        }
        if (queued.get() >= MAX_QUEUE) return; // the page is behind: drop rather than run out of memory
        queue.add(message);
        queued.incrementAndGet();
    }

    @Override
    public void onFailure(WebSocket ws, Throwable t, Response response) {
        Diagnostics.log("W", "AIS", "Connection failed: " + t.getMessage() + (response != null ? " (HTTP " + response.code() + ")" : ""));
        scheduleReconnect(ws);
    }

    @Override
    public void onClosed(WebSocket ws, int code, String reason) {
        Diagnostics.log("W", "AIS", "Closed by server: " + code + " " + reason);
        scheduleReconnect(ws);
    }

    private synchronized void scheduleReconnect(WebSocket ws) {
        if (!running || ws != socket) return;
        status("reconnecting");
        socket = null;
        main.postDelayed(() -> {
            synchronized (AisStreamClient.this) {
                if (running && socket == null) connect();
            }
        }, retryMs);
        retryMs = Math.min(retryMs * 2, 5 * 60 * 1000);
    }

    private void status(String status) {
        main.post(() -> web.evaluateJavascript("window.__aisStatus && window.__aisStatus(" + JSONObject.quote(status) + ")", null));
    }

    private final Runnable flush = new Runnable() {
        @Override
        public void run() {
            if (!queue.isEmpty()) {
                StringBuilder batch = new StringBuilder("[");
                int n = 0;
                String msg;
                while (n < MAX_BATCH && (msg = queue.poll()) != null) {
                    queued.decrementAndGet();
                    if (n++ > 0) batch.append(',');
                    batch.append(msg);
                }
                batch.append(']');
                web.evaluateJavascript("window.__aisBatch && window.__aisBatch(" + JSONObject.quote(batch.toString()) + ")", null);
            }
            if (++flushes % 60 == 0) Diagnostics.log("I", "AIS", received + " messages received so far");
            if (running) main.postDelayed(this, 1000);
        }
    };
}
