"""What a voice app has to ask Android for. Run over the generated AndroidManifest.xml; running it twice changes nothing."""
import re
import sys

PERMISSIONS = [
    "android.permission.RECORD_AUDIO",
    "android.permission.MODIFY_AUDIO_SETTINGS",
    "android.permission.CAMERA",
    "android.permission.INTERNET",
    "android.permission.ACCESS_NETWORK_STATE",
    # The server hosted on a phone finds its home network's router (UPnP) and the call's addresses.
    "android.permission.ACCESS_WIFI_STATE",
    "android.permission.CHANGE_WIFI_MULTICAST_STATE",
    "android.permission.WAKE_LOCK",
    "android.permission.BLUETOOTH_CONNECT",
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_MICROPHONE",
    "android.permission.FOREGROUND_SERVICE_CAMERA",
    "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION",
    "android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
    "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
    "android.permission.POST_NOTIFICATIONS",
    # Updates from the friend's server (checked by the publisher's seal first; Android checks the signing key again).
    "android.permission.REQUEST_INSTALL_PACKAGES",
]
# A phone without a camera still installs it.
FEATURES = [
    "android.hardware.camera",
    "android.hardware.camera.front",
    "android.hardware.microphone",
]
SERVICE = """        <service
            android:name=".CallService"
            android:exported="false"
            android:foregroundServiceType="microphone|camera|mediaProjection|specialUse|dataSync">
            <property
                android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
                android:value="A voice chat server hosted on this phone for the owner's friends" />
        </service>
"""

WATCH = """        <activity
            android:name=".WatchActivity"
            android:exported="false"
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|smallestScreenSize|screenLayout|uiMode"
            android:theme="@style/Theme.hatavoice" />
"""

# «Управление с ПК»: the accessibility service a friend's input goes through (only the system may bind it).
CONTROL = """        <service
            android:name=".ControlService"
            android:exported="true"
            android:label="@string/control_label"
            android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE">
            <intent-filter>
                <action android:name="android.accessibilityservice.AccessibilityService" />
            </intent-filter>
            <meta-data
                android:name="android.accessibilityservice"
                android:resource="@xml/control_service" />
        </service>
"""


def before_application(text: str, line: str) -> str:
    at = text.index("<application")
    at = text.rindex("\n", 0, at) + 1
    return text[:at] + line + text[at:]


path = sys.argv[1]
text = open(path, encoding="utf-8").read()
for permission in PERMISSIONS:
    if f'"{permission}"' not in text:
        text = before_application(text, f'    <uses-permission android:name="{permission}" />\n')
for feature in FEATURES:
    if f'"{feature}"' not in text:
        text = before_application(text, f'    <uses-feature android:name="{feature}" android:required="false" />\n')
# The service from older runs of this script declared the microphone alone: it is put back whole.
text = re.sub(r"        <service\s+android:name=\"\.CallService\"[^>]*?(/>|>.*?</service>)\n", "", text, flags=re.S)
at = text.index("</application>")
at = text.rindex("\n", 0, at) + 1
text = text[:at] + SERVICE + text[at:]
if "networkSecurityConfig" not in text:
    text = text.replace("<application", '<application\n        android:networkSecurityConfig="@xml/network_security_config"', 1)
# The server and LiveKit are programs packed as libraries: Android starts programs only from the libraries' folder, so
# they must be unpacked there on install.
if "extractNativeLibs" not in text:
    text = text.replace("<application", '<application\n        android:extractNativeLibs="true"', 1)
# Recordings go to the shared «Movies» folder; Android 10 needs the old storage rules for that.
if "requestLegacyExternalStorage" not in text:
    text = text.replace("<application", '<application\n        android:requestLegacyExternalStorage="true"', 1)
# «Любой сайт» in watch-together: a window of its own (WatchActivity).
if ".WatchActivity" not in text:
    # Before the file provider, so that the service (put back at the end on every run) never trades places with it.
    at = text.find("<provider")
    at = text.index("</application>") if at < 0 else at
    at = text.rindex("\n", 0, at) + 1
    text = text[:at] + WATCH + text[at:]
if ".ControlService" not in text:
    at = text.find("<provider")
    at = text.index("</application>") if at < 0 else at
    at = text.rindex("\n", 0, at) + 1
    text = text[:at] + CONTROL + text[at:]
# The page gets shorter by the keyboard (MainActivity applies its height), never hides a field under it.
if "windowSoftInputMode" not in text:
    text = text.replace('android:name=".MainActivity"', 'android:name=".MainActivity"\n            android:windowSoftInputMode="adjustResize"', 1)
# The call in a small window over other apps.
if "supportsPictureInPicture" not in text:
    text = text.replace(
        'android:name=".MainActivity"',
        'android:name=".MainActivity"\n            android:supportsPictureInPicture="true"\n            android:resizeableActivity="true"',
        1,
    )
open(path, "w", encoding="utf-8").write(text)
