// Unit tests for the DealVerse shell's URL routing helpers. These are pure
// functions, so they don't require the WebView platform channels.
import 'package:flutter_test/flutter_test.dart';
import 'package:dealverse_app/main.dart';

void main() {
  group('isAdminUrl', () {
    test('admin page is detected', () {
      expect(isAdminUrl('https://f54vu9h2ra.execute-api.ap-south-1.amazonaws.com/prod/admin'), isTrue);
      expect(isAdminUrl('https://f54vu9h2ra.execute-api.ap-south-1.amazonaws.com/prod/admin/'), isTrue);
    });

    test('user/home pages are not admin', () {
      expect(isAdminUrl('https://f54vu9h2ra.execute-api.ap-south-1.amazonaws.com/prod/home'), isFalse);
      expect(isAdminUrl('https://f54vu9h2ra.execute-api.ap-south-1.amazonaws.com/prod/'), isFalse);
    });
  });

  group('isInternalUrl', () {
    test('DealVerse pages stay internal', () {
      expect(isInternalUrl(kHomeUrl), isTrue);
      expect(isInternalUrl(kAdminUrl), isTrue);
      expect(isInternalUrl('https://f54vu9h2ra.execute-api.ap-south-1.amazonaws.com/prod/api/affiliate/status'), isTrue);
    });

    test('external affiliate links are not internal', () {
      expect(isInternalUrl('https://amzn.to/4qkXPb1'), isFalse);
      expect(isInternalUrl('https://www.amazon.in/dp/B0CHN2YDPG?tag=x'), isFalse);
      expect(isInternalUrl('https://link.amazon/B0eUzWGT0'), isFalse);
    });
  });
}
