package com.flighttracker.app;

import android.app.Activity;
import android.util.DisplayMetrics;
import android.view.View;
import android.widget.FrameLayout;

import com.google.android.gms.ads.AdListener;
import com.google.android.gms.ads.AdRequest;
import com.google.android.gms.ads.AdSize;
import com.google.android.gms.ads.AdView;
import com.google.android.gms.ads.LoadAdError;
import com.google.android.gms.ads.MobileAds;
import com.google.android.ump.ConsentInformation;
import com.google.android.ump.ConsentRequestParameters;
import com.google.android.ump.UserMessagingPlatform;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * AdMob banner at the bottom of the screen, shown only after the user's consent choice
 * (Google User Messaging Platform – required for users in the EEA, UK and Switzerland).
 */
final class AdsController {
    private final Activity activity;
    private final FrameLayout container;
    private final AtomicBoolean started = new AtomicBoolean(false);
    private ConsentInformation consent;
    private AdView adView;

    AdsController(Activity activity, FrameLayout container) {
        this.activity = activity;
        this.container = container;
    }

    void start() {
        consent = UserMessagingPlatform.getConsentInformation(activity);
        ConsentRequestParameters params = new ConsentRequestParameters.Builder().build();
        consent.requestConsentInfoUpdate(activity, params,
            () -> UserMessagingPlatform.loadAndShowConsentFormIfRequired(activity, formError -> {
                if (formError != null) Diagnostics.log("W", "Ads", "Consent form: " + formError.getMessage());
                startAdsIfAllowed();
            }),
            requestError -> {
                Diagnostics.log("W", "Ads", "Consent info: " + requestError.getMessage());
                startAdsIfAllowed();
            });
        // Consent given in an earlier session lets ads start without waiting for the update.
        startAdsIfAllowed();
    }

    private void startAdsIfAllowed() {
        if (!consent.canRequestAds() || !started.compareAndSet(false, true)) return;
        new Thread(() -> {
            MobileAds.initialize(activity, status -> { });
            activity.runOnUiThread(this::loadBanner);
        }, "ads-init").start();
    }

    private void loadBanner() {
        if (activity.isFinishing() || activity.isDestroyed()) return;
        adView = new AdView(activity);
        adView.setAdUnitId(BuildConfig.BANNER_AD_UNIT_ID);
        DisplayMetrics metrics = activity.getResources().getDisplayMetrics();
        int widthDp = (int) (metrics.widthPixels / metrics.density);
        adView.setAdSize(AdSize.getCurrentOrientationAnchoredAdaptiveBannerAdSize(activity, widthDp));
        adView.setAdListener(new AdListener() {
            @Override
            public void onAdLoaded() {
                container.setVisibility(View.VISIBLE);
            }

            @Override
            public void onAdFailedToLoad(LoadAdError error) {
                Diagnostics.log("W", "Ads", "Banner failed: " + error.getCode() + " " + error.getMessage());
            }
        });
        container.removeAllViews();
        container.addView(adView);
        adView.loadAd(new AdRequest.Builder().build());
    }

    boolean isPrivacyOptionsRequired() {
        return consent != null && consent.getPrivacyOptionsRequirementStatus()
            == ConsentInformation.PrivacyOptionsRequirementStatus.REQUIRED;
    }

    void showPrivacyOptions() {
        UserMessagingPlatform.showPrivacyOptionsForm(activity, error -> {
            if (error != null) Diagnostics.log("W", "Ads", "Privacy options: " + error.getMessage());
        });
    }

    void pause() {
        if (adView != null) adView.pause();
    }

    void resume() {
        if (adView != null) adView.resume();
    }

    void destroy() {
        if (adView != null) adView.destroy();
    }
}
