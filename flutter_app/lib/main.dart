import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const DealVerseApp());
}

// Deployed DealVerse web app. Flutter is only a shell around it — all login,
// affiliate generation and admin logic live in the React/Lambda app.
const String kHost = 'f54vu9h2ra.execute-api.ap-south-1.amazonaws.com';
const String kHomeUrl = 'https://$kHost/prod/home';
const String kAdminUrl = 'https://$kHost/prod/admin';

/// True when [url] is the admin view (used to toggle the Admin/User button).
bool isAdminUrl(String url) {
  final path = (Uri.tryParse(url)?.path ?? '').replaceAll(RegExp(r'/+$'), '');
  return path.endsWith('/admin');
}

/// True when [url] is a DealVerse page (stays in the WebView); anything else
/// (affiliate links, amazon.in, amzn.to, …) opens in the system browser.
bool isInternalUrl(String url) {
  final uri = Uri.tryParse(url);
  if (uri == null) return true;
  return uri.host == kHost || uri.scheme == 'about' || uri.scheme == 'data';
}

class DealVerseApp extends StatelessWidget {
  const DealVerseApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'DealVerse',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF3B82F6),
          brightness: Brightness.dark,
        ),
        useMaterial3: true,
      ),
      home: const WebShellPage(),
    );
  }
}

class WebShellPage extends StatefulWidget {
  const WebShellPage({super.key});

  @override
  State<WebShellPage> createState() => _WebShellPageState();
}

class _WebShellPageState extends State<WebShellPage> {
  // A single, persistent controller so the React app's localStorage admin
  // token survives user <-> admin switching AND full app restarts.
  //
  // Persistence notes (webview_flutter 4.x / webview_flutter_android):
  //   * DOM storage / localStorage is enabled by default in
  //     AndroidWebViewController (it calls setDomStorageEnabled(true) on
  //     creation), and Android's WebView writes localStorage to disk under the
  //     app's data dir, so the token survives the app being closed & reopened.
  //   * Cookies are persisted automatically by Android's CookieManager.
  //   * We deliberately never clear cache, cookies or web storage here — logout
  //     is owned by the website's own "Log out" button (it clears localStorage).
  late final WebViewController _controller;

  bool _loading = true;
  bool _hasError = false;
  int _progress = 0;

  @override
  void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFF0F1115))
      ..setNavigationDelegate(
        NavigationDelegate(
          onProgress: (p) => setState(() => _progress = p),
          onPageStarted: (url) => setState(() {
            _loading = true;
            _hasError = false;
          }),
          onPageFinished: (url) => setState(() => _loading = false),
          onWebResourceError: (error) {
            // Only surface full-page failures, not sub-resource hiccups.
            if (error.isForMainFrame ?? true) {
              setState(() {
                _hasError = true;
                _loading = false;
              });
            }
          },
          onNavigationRequest: _handleNavigation,
        ),
      )
      // Open the admin panel by default; a persisted localStorage token keeps
      // the admin logged in across restarts.
      ..loadRequest(Uri.parse(kAdminUrl));
  }

  // Keep DealVerse pages inside the WebView; send everything else (affiliate
  // links, amazon.in, amzn.to, link.amazon, …) to the system browser.
  Future<NavigationDecision> _handleNavigation(NavigationRequest request) async {
    if (isInternalUrl(request.url)) return NavigationDecision.navigate;
    final uri = Uri.tryParse(request.url);
    if (uri != null) await _openExternally(uri);
    return NavigationDecision.prevent;
  }

  Future<void> _openExternally(Uri uri) async {
    try {
      if (await canLaunchUrl(uri)) {
        await launchUrl(uri, mode: LaunchMode.externalApplication);
      }
    } catch (_) {
      // Ignore: nothing sensible to do if no external handler exists.
    }
  }

  void _retry() {
    setState(() {
      _hasError = false;
      _loading = true;
    });
    _controller.reload();
  }

  Future<void> _handleBack(bool didPop, Object? result) async {
    if (didPop) return;
    if (await _controller.canGoBack()) {
      await _controller.goBack();
    } else {
      // Nothing to go back to — leave the app.
      await SystemNavigator.pop();
    }
  }

  @override
  Widget build(BuildContext context) {
    // No app bar: the deployed web app has its own header (with logo and the
    // Admin/User toggle), so a native one would duplicate the Admin button.
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: _handleBack,
      child: Scaffold(
        backgroundColor: const Color(0xFF0F1115),
        body: SafeArea(
          child: _hasError
              ? _errorView()
              : Stack(
                  children: [
                    WebViewWidget(controller: _controller),
                    if (_loading)
                      LinearProgressIndicator(
                        value: _progress > 0 && _progress < 100 ? _progress / 100 : null,
                        minHeight: 3,
                      ),
                  ],
                ),
        ),
      ),
    );
  }

  Widget _errorView() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.wifi_off, size: 48),
            const SizedBox(height: 16),
            const Text(
              'Could not load DealVerse.\nCheck your connection and try again.',
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 20),
            FilledButton.icon(
              onPressed: _retry,
              icon: const Icon(Icons.refresh),
              label: const Text('Retry'),
            ),
          ],
        ),
      ),
    );
  }
}
