# DealVerse — Flutter Android shell

A thin **Android-only** Flutter app that wraps the already-deployed DealVerse web
app in a single WebView. It adds no business logic: login, affiliate-link
generation, admin APIs, bot/channel/listener config all remain in the deployed
React + Lambda application.

- Default view: `https://f54vu9h2ra.execute-api.ap-south-1.amazonaws.com/prod/home`
- Admin view: `…/prod/admin` (toggled from the app bar)

## Design

- **One persistent `WebViewController`** (not two WebViews). The React app keeps
  the admin auth token in browser `sessionStorage`; reusing one controller means
  switching between the user and admin views never drops that session.
- **App-bar toggle:** shows **Admin** on the user view and **User** on the admin
  view; both just `loadRequest` the same controller.
- **Android back** navigates WebView history first, and only exits the app when
  there's nothing left to go back to.
- **Loading** shows a progress bar; **failures** show a Retry button.
- **External links** (affiliate links — amazon.in, amzn.to, link.amazon, …) open
  in the system browser; DealVerse pages (`host == …amazonaws.com`) stay in the
  WebView. See `isInternalUrl` / `isAdminUrl` in `lib/main.dart`.

## Prerequisites (Android)

Flutter 3.41.9 / Dart 3.11.5 and Android Studio are assumed installed. If the
Android toolchain is incomplete:

```bash
# Command-line tools (once), then licenses:
flutter doctor --android-licenses
flutter doctor -v        # should show a green Android toolchain
flutter emulators        # a Pixel_8 AVD is available in this environment
flutter devices
```

## Build & run

```bash
cd flutter_app
flutter pub get
flutter analyze
flutter test
flutter emulators --launch Pixel_8   # or plug in a device
flutter run                          # or: flutter build apk --debug
```

The debug APK is written to `build/app/outputs/flutter-apk/app-debug.apk`.

## Scope

This project touches **only** `flutter_app/`. It does not modify or deploy the
AWS CDK, Lambda, React frontend, API Gateway, DynamoDB, or root Node.js files.
