import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'ble_manager.dart';
import 'theme/app_theme.dart';
import 'splash_screen.dart';
import 'screens/scan_screen.dart';
import 'screens/instrument_dashboard.dart';

void main() async {
  // Ensure Flutter engine bindings are initialized
  WidgetsFlutterBinding.ensureInitialized();

  // Lock orientation to Landscape
  await SystemChrome.setPreferredOrientations([
    DeviceOrientation.landscapeLeft,
    DeviceOrientation.landscapeRight,
  ]);

  // Set immersive sticky full-screen mode to hide status bar & navigation keys
  await SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);

  runApp(
    ChangeNotifierProvider(
      create: (_) => BleManager(),
      child: const MyApp(),
    ),
  );
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'ISRO Smart Wireless Accelerometer',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.light,
        primaryColor: AppColors.primary,
        scaffoldBackgroundColor: AppColors.background,
        cardColor: AppColors.surfaceHigh,
        dividerColor: AppColors.divider,
        textTheme: const TextTheme(
          bodyLarge: TextStyle(color: AppColors.textPrimary),
          bodyMedium: TextStyle(color: AppColors.textSecondary),
        ),
        colorScheme: const ColorScheme.light(
          primary: AppColors.primary,
          secondary: AppColors.saffron,
          surface: AppColors.surface,
          error: AppColors.error,
        ),
        useMaterial3: true,
      ),
      home: const AppNavigator(),
    );
  }
}

/// App-level navigator managing screen transitions:
/// Splash → Scan → Dashboard
class AppNavigator extends StatefulWidget {
  const AppNavigator({super.key});

  @override
  State<AppNavigator> createState() => _AppNavigatorState();
}

class _AppNavigatorState extends State<AppNavigator> {
  // 0 = Splash, 1 = Scan, 2 = Dashboard
  int _screen = 0;

  void _goToScan() {
    setState(() => _screen = 1);
  }

  void _goToDashboard() {
    setState(() => _screen = 2);
  }

  void _goBackToScan() {
    setState(() => _screen = 1);
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 500),
      transitionBuilder: (child, animation) {
        return FadeTransition(opacity: animation, child: child);
      },
      child: _buildScreen(),
    );
  }

  Widget _buildScreen() {
    switch (_screen) {
      case 0:
        return SplashScreen(
          key: const ValueKey('splash'),
          onComplete: _goToScan,
        );
      case 1:
        return ScanScreen(
          key: const ValueKey('scan'),
          onDeviceReady: _goToDashboard,
        );
      case 2:
      default:
        return InstrumentDashboard(
          key: const ValueKey('dashboard'),
          onBack: _goBackToScan,
        );
    }
  }
}
