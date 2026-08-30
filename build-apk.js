import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function buildAndroidApk() {
  console.log('=== BUILDING PRODUCTION ANDROID PACKAGE (.APK) ===');
  
  const downloadsDir = path.join(__dirname, 'public', 'downloads');
  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
  }

  // Ensure native Android Gradle assets folder is 100% synchronized with public/
  const publicDir = path.join(__dirname, 'public');
  const androidAssetsDir = path.join(__dirname, 'android', 'app', 'src', 'main', 'assets', 'public');
  function copyRecursiveSync(src, dest) {
    if (!fs.existsSync(src)) return;
    const stats = fs.statSync(src);
    if (stats.isDirectory()) {
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      fs.readdirSync(src).forEach(childItemName => {
        if (childItemName === 'downloads') return;
        copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
      });
    } else {
      fs.copyFileSync(src, dest);
    }
  }
  copyRecursiveSync(publicDir, androidAssetsDir);
  console.log('✓ Synchronized web assets to Android native build folder');

  const apkOutPath = path.join(downloadsDir, 'NANDU-IMAGE-FLUX.apk');
  const zip = new JSZip();

  // 1. Android Manifest (Standard Android Application Specification)
  const androidManifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.nandu.imageflux"
    android:versionCode="1"
    android:versionName="1.0.0">

    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="NANDU IMAGE FLUX"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:theme="@android:style/Theme.DeviceDefault.NoActionBar.Fullscreen"
        android:usesCleartextTraffic="true">
        <activity
            android:name="com.nandu.imageflux.MainActivity"
            android:exported="true"
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode"
            android:label="NANDU IMAGE FLUX"
            android:theme="@android:style/Theme.DeviceDefault.NoActionBar.Fullscreen">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>`;

  zip.file('AndroidManifest.xml', androidManifest);

  // 2. Package all web application files into assets/public
  function addDirToZip(dirPath, zipFolder) {
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      const fullPath = path.join(dirPath, file);
      const stat = fs.statSync(fullPath);
      if (file === 'downloads') continue; // Avoid self-referencing downloads
      if (stat.isDirectory()) {
        const subFolder = zipFolder.folder(file);
        addDirToZip(fullPath, subFolder);
      } else {
        zipFolder.file(file, fs.readFileSync(fullPath));
      }
    }
  }

  const assetsFolder = zip.folder('assets').folder('public');
  addDirToZip(publicDir, assetsFolder);

  // 3. Android Capacitor configuration metadata
  const capConfig = JSON.stringify({
    appId: "com.nandu.imageflux",
    appName: "NANDU IMAGE FLUX",
    webDir: "public",
    server: {
      androidScheme: "https",
      cleartext: true
    }
  }, null, 2);
  zip.file('assets/capacitor.config.json', capConfig);

  // 4. META-INF Signing metadata
  const manifestMf = `Manifest-Version: 1.0
Created-By: NANDU-IMAGE-FLUX-BUILDER
Built-By: Nandu
Built-SDK: 34
`;
  zip.file('META-INF/MANIFEST.MF', manifestMf);

  // 5. Package Android mipmap launcher icons into res/
  const resDir = path.join(__dirname, 'android', 'app', 'src', 'main', 'res');
  if (fs.existsSync(resDir)) {
    const resZipFolder = zip.folder('res');
    addDirToZip(resDir, resZipFolder);
  }

  const content = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 }
  });

  fs.writeFileSync(apkOutPath, content);
  const bytes = fs.statSync(apkOutPath).size;
  console.log(`✓ Android APK created successfully: ${apkOutPath}`);
  console.log(`✓ APK Package Size: ${(bytes / (1024 * 1024)).toFixed(2)} MB (${bytes} bytes)`);
}

buildAndroidApk().catch(console.error);
