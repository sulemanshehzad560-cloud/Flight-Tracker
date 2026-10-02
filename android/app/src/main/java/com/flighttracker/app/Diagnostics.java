package com.flighttracker.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.util.Log;
import android.webkit.WebView;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.PrintWriter;
import java.io.RandomAccessFile;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Crash and problem diagnostics.
 *
 * - Java crashes are written to a local log (and still reported to Play Console's Android vitals).
 * - JavaScript errors from the web app arrive through {@link #log} and go to the same log and to logcat.
 * - Users can send the log with "Send diagnostics report" in the app's settings, or are offered it
 *   the next time they open the app after a crash.
 */
public final class Diagnostics {
    private static final String TAG = "AirSeaRadar";
    private static final long MAX_LOG_BYTES = 256 * 1024;
    private static final int MAX_REPORT_CHARS = 60_000;

    private static File logFile;
    private static File crashMarker;
    private static boolean crashedLastSession;

    private Diagnostics() {}

    public static synchronized void init(Context context) {
        File dir = new File(context.getFilesDir(), "diagnostics");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        logFile = new File(dir, "app.log");
        crashMarker = new File(dir, "crashed");
        crashedLastSession = crashMarker.exists();

        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try {
                log("F", "Crash", "Uncaught exception on thread " + thread.getName() + "\n" + stackTrace(error));
                //noinspection ResultOfMethodCallIgnored
                crashMarker.createNewFile();
            } catch (Throwable ignored) {
                // never let logging hide the real crash
            }
            if (previous != null) previous.uncaughtException(thread, error);
        });
        log("I", "App", "Started " + BuildConfig.VERSION_NAME + " (" + BuildConfig.VERSION_CODE + ")");
    }

    /** level: V/D/I/W/E/F. */
    public static synchronized void log(String level, String source, String message) {
        int priority;
        switch (level) {
            case "E": case "F": priority = Log.ERROR; break;
            case "W": priority = Log.WARN; break;
            case "D": case "V": priority = Log.DEBUG; break;
            default: priority = Log.INFO;
        }
        Log.println(priority, TAG, source + ": " + message);
        if (logFile == null) return;
        String time = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(new Date());
        String line = time + " " + level + "/" + source + ": " + message + "\n";
        try {
            if (logFile.length() > MAX_LOG_BYTES) trimLog();
            try (FileOutputStream out = new FileOutputStream(logFile, true)) {
                out.write(line.getBytes(StandardCharsets.UTF_8));
            }
        } catch (IOException e) {
            Log.w(TAG, "Could not write diagnostics log", e);
        }
    }

    /** Keeps the newest half of the log. */
    private static void trimLog() throws IOException {
        byte[] tail;
        try (RandomAccessFile file = new RandomAccessFile(logFile, "r")) {
            long keep = MAX_LOG_BYTES / 2;
            file.seek(file.length() - keep);
            tail = new byte[(int) keep];
            file.readFully(tail);
        }
        try (FileOutputStream out = new FileOutputStream(logFile, false)) {
            out.write(tail);
        }
    }

    /** True once per crash: the previous session ended with an uncaught exception. */
    public static synchronized boolean consumeCrashFlag() {
        boolean crashed = crashedLastSession;
        crashedLastSession = false;
        if (crashMarker != null) {
            //noinspection ResultOfMethodCallIgnored
            crashMarker.delete();
        }
        return crashed;
    }

    public static String stackTrace(Throwable t) {
        StringWriter sw = new StringWriter();
        t.printStackTrace(new PrintWriter(sw));
        return sw.toString();
    }

    /** Device + app information and the most recent log lines. */
    public static synchronized String buildReport(Context context) {
        StringBuilder r = new StringBuilder();
        r.append("AirSea Radar diagnostics report\n")
            .append("App: ").append(BuildConfig.VERSION_NAME).append(" (").append(BuildConfig.VERSION_CODE).append(")\n")
            .append("Device: ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL).append('\n')
            .append("Android: ").append(Build.VERSION.RELEASE).append(" (API ").append(Build.VERSION.SDK_INT).append(")\n");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            PackageInfo webView = WebView.getCurrentWebViewPackage();
            if (webView != null) r.append("WebView: ").append(webView.packageName).append(' ').append(webView.versionName).append('\n');
        }
        r.append("\n--- Log ---\n");
        String log = readLog();
        if (log.length() > MAX_REPORT_CHARS) log = "…" + log.substring(log.length() - MAX_REPORT_CHARS);
        return r.append(log).toString();
    }

    private static String readLog() {
        if (logFile == null || !logFile.exists()) return "(empty)";
        try (RandomAccessFile file = new RandomAccessFile(logFile, "r")) {
            byte[] data = new byte[(int) file.length()];
            file.readFully(data);
            return new String(data, StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "(could not read log: " + e.getMessage() + ")";
        }
    }

    /** Opens the share sheet (email, messaging…) with the diagnostics report. */
    public static void share(Activity activity) {
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("text/plain");
        send.putExtra(Intent.EXTRA_SUBJECT, "AirSea Radar diagnostics " + BuildConfig.VERSION_NAME);
        send.putExtra(Intent.EXTRA_TEXT, buildReport(activity));
        activity.startActivity(Intent.createChooser(send, "Send diagnostics report"));
    }
}
