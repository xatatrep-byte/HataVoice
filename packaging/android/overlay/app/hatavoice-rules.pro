# Rust calls in by name (JNI): R8 must not rename the classes with native methods, or the methods themselves.
-keepclasseswithmembernames class com.hatavoice.app.** {
    native <methods>;
}
