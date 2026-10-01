# Methods the web page calls through addJavascriptInterface() must keep their names.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface

# Readable stack traces in Play Console (with the mapping file uploaded alongside the bundle).
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
