package com.flighttracker.app;

import android.app.Application;

/** Installs crash logging before anything else runs. */
public class FlightTrackerApp extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        Diagnostics.init(this);
    }
}
