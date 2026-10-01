plugins {
    id("com.android.application")
}

// AdMob. Release builds show real ads; debug builds use Google's official test IDs, so testing
// on your own phone never generates invalid clicks on your account.
val admobAppId = "ca-app-pub-4940350948200557~3019084921"
val admobBannerId = "ca-app-pub-4940350948200557/4519868857"
val admobTestAppId = "ca-app-pub-3940256099942544~3347511713"
val admobTestBannerId = "ca-app-pub-3940256099942544/9214589741"

// Upload-key signing comes from the environment (GitHub Actions secrets); never commit the keystore.
val keystoreFile: String? = System.getenv("ANDROID_KEYSTORE_FILE")

android {
    namespace = "com.flighttracker.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.flighttracker.app"
        minSdk = 23
        targetSdk = 36
        versionCode = (System.getenv("VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("VERSION_NAME") ?: "1.0.0"
        manifestPlaceholders["admobAppId"] = admobAppId
        buildConfigField("String", "BANNER_AD_UNIT_ID", "\"$admobBannerId\"")
    }

    signingConfigs {
        if (keystoreFile != null) {
            create("upload") {
                storeFile = file(keystoreFile)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (keystoreFile != null) signingConfigs.getByName("upload") else signingConfigs.getByName("debug")
            // Ship native debug symbols (from the ads SDK, if any) so Play Console can symbolicate native crashes.
            ndk { debugSymbolLevel = "FULL" }
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            manifestPlaceholders["admobAppId"] = admobTestAppId
            buildConfigField("String", "BANNER_AD_UNIT_ID", "\"$admobTestBannerId\"")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/webassets"))
}

dependencies {
    implementation("com.google.android.gms:play-services-ads:24.4.0")
    implementation("com.google.android.ump:user-messaging-platform:3.2.0")
}

// Bundle the web app (../public, ../lib) and MapLibre into the APK/AAB assets.
val prepareWebAssets by tasks.registering(Exec::class) {
    val out = layout.buildDirectory.dir("generated/webassets").get().asFile
    inputs.dir(rootProject.file("../public"))
    inputs.dir(rootProject.file("../lib"))
    inputs.file(rootProject.file("prepare-web-assets.sh"))
    outputs.dir(out)
    commandLine("bash", rootProject.file("prepare-web-assets.sh").absolutePath, out.absolutePath)
}
tasks.named("preBuild") { dependsOn(prepareWebAssets) }
