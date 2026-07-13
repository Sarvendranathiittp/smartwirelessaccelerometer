import 'package:flutter/material.dart';
import 'theme/app_theme.dart';

class SplashScreen extends StatefulWidget {
  final VoidCallback onComplete;

  const SplashScreen({super.key, required this.onComplete});

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen> with TickerProviderStateMixin {
  late AnimationController _mainController;
  late AnimationController _pulseController;
  late Animation<double> _logoFade;
  late Animation<double> _titleFade;
  late Animation<double> _subtitleFade;
  late Animation<double> _barFade;
  late Animation<double> _barProgress;

  @override
  void initState() {
    super.initState();

    _mainController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 3000),
    );

    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1500),
    )..repeat(reverse: true);

    // Staggered animations
    _logoFade = CurvedAnimation(
      parent: _mainController,
      curve: const Interval(0.0, 0.3, curve: Curves.easeOut),
    );

    _titleFade = CurvedAnimation(
      parent: _mainController,
      curve: const Interval(0.15, 0.45, curve: Curves.easeOut),
    );

    _subtitleFade = CurvedAnimation(
      parent: _mainController,
      curve: const Interval(0.3, 0.6, curve: Curves.easeOut),
    );

    _barFade = CurvedAnimation(
      parent: _mainController,
      curve: const Interval(0.5, 0.7, curve: Curves.easeOut),
    );

    _barProgress = CurvedAnimation(
      parent: _mainController,
      curve: const Interval(0.5, 1.0, curve: Curves.easeInOut),
    );

    _mainController.forward();

    // Navigate after animation completes
    Future.delayed(const Duration(milliseconds: 3500), () {
      if (mounted) {
        widget.onComplete();
      }
    });
  }

  @override
  void dispose() {
    _mainController.dispose();
    _pulseController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF4F9FF),
      body: Stack(
        children: [
          // Technical Grid Overlay
          Positioned.fill(
            child: CustomPaint(
              painter: _GridOverlayPainter(),
            ),
          ),

          // Main Content
          SafeArea(
            child: AnimatedBuilder(
              animation: _mainController,
              builder: (context, _) {
                return Center(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      // Rocket Icon Box with Saffron Brackets
                      FadeTransition(
                        opacity: _logoFade,
                        child: Container(
                          width: 96,
                          height: 96,
                          decoration: BoxDecoration(
                            color: Colors.white,
                            borderRadius: BorderRadius.circular(24),
                            border: Border.all(color: const Color(0xCCCBD5E1), width: 1),
                            boxShadow: [
                              BoxShadow(
                                color: Colors.black.withOpacity(0.03),
                                blurRadius: 12,
                                offset: const Offset(0, 4),
                              ),
                              BoxShadow(
                                color: AppColors.primary.withOpacity(0.05),
                                blurRadius: 15,
                              ),
                            ],
                          ),
                          child: Stack(
                            children: [
                              // Saffron brackets
                              Positioned(
                                top: -0.5,
                                left: -0.5,
                                child: Container(
                                  width: 14,
                                  height: 14,
                                  decoration: const BoxDecoration(
                                    border: Border(
                                      top: BorderSide(color: AppColors.saffron, width: 2),
                                      left: BorderSide(color: AppColors.saffron, width: 2),
                                    ),
                                  ),
                                ),
                              ),
                              Positioned(
                                top: -0.5,
                                right: -0.5,
                                child: Container(
                                  width: 14,
                                  height: 14,
                                  decoration: const BoxDecoration(
                                    border: Border(
                                      top: BorderSide(color: AppColors.saffron, width: 2),
                                      right: BorderSide(color: AppColors.saffron, width: 2),
                                    ),
                                  ),
                                ),
                              ),
                              Positioned(
                                bottom: -0.5,
                                left: -0.5,
                                child: Container(
                                  width: 14,
                                  height: 14,
                                  decoration: const BoxDecoration(
                                    border: Border(
                                      bottom: BorderSide(color: AppColors.saffron, width: 2),
                                      left: BorderSide(color: AppColors.saffron, width: 2),
                                    ),
                                  ),
                                ),
                              ),
                              Positioned(
                                bottom: -0.5,
                                right: -0.5,
                                child: Container(
                                  width: 14,
                                  height: 14,
                                  decoration: const BoxDecoration(
                                    border: Border(
                                      bottom: BorderSide(color: AppColors.saffron, width: 2),
                                      right: BorderSide(color: AppColors.saffron, width: 2),
                                    ),
                                  ),
                                ),
                              ),
                              // Centered icon
                              const Center(
                                child: Icon(
                                  Icons.rocket_launch,
                                  size: 48,
                                  color: AppColors.primary,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(height: 24),

                      // Text Headers
                      FadeTransition(
                        opacity: _titleFade,
                        child: const Text(
                          'Smart Wireless Accelerometer',
                          style: TextStyle(
                            fontSize: 24,
                            fontWeight: FontWeight.bold,
                            color: AppColors.navy,
                            letterSpacing: -0.5,
                          ),
                        ),
                      ),
                      const SizedBox(height: 6),
                      FadeTransition(
                        opacity: _titleFade,
                        child: const Text(
                          'PRECISION WIRELESS DATA ACQUISITION PLATFORM',
                          style: TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.bold,
                            color: Color(0x990B192C),
                            letterSpacing: 2.0,
                          ),
                        ),
                      ),
                      const SizedBox(height: 36),

                      // Loading status indicators
                      FadeTransition(
                        opacity: _barFade,
                        child: Column(
                          children: [
                            SizedBox(
                              width: 256,
                              child: ClipRRect(
                                borderRadius: BorderRadius.circular(1.5),
                                child: LinearProgressIndicator(
                                  value: _barProgress.value,
                                  backgroundColor: const Color(0xFFE2E8F0),
                                  color: AppColors.primary,
                                  minHeight: 3,
                                ),
                              ),
                            ),
                            const SizedBox(height: 10),
                            SizedBox(
                              width: 256,
                              child: Row(
                                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                children: [
                                  Text(
                                    _barProgress.value < 0.3
                                        ? 'Initializing Application...'
                                        : _barProgress.value < 0.7
                                            ? 'Connecting Telemetry Core...'
                                            : 'System Ready',
                                    style: const TextStyle(
                                      fontSize: 9,
                                      fontFamily: 'monospace',
                                      fontWeight: FontWeight.bold,
                                      color: Color(0xCC0B192C),
                                    ),
                                  ),
                                  Text(
                                    '${(_barProgress.value * 100).toInt()}%',
                                    style: const TextStyle(
                                      fontSize: 9,
                                      fontFamily: 'monospace',
                                      fontWeight: FontWeight.bold,
                                      color: AppColors.primary,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 28),

                      // Partner Logos Badge Row
                      FadeTransition(
                        opacity: _subtitleFade,
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Container(
                              padding: const EdgeInsets.all(4),
                              decoration: BoxDecoration(
                                color: Colors.white,
                                borderRadius: BorderRadius.circular(6),
                                border: Border.all(color: const Color(0xFFE2E8F0)),
                              ),
                              child: Image.asset('assets/SMA_lab_logo.png', height: 32, fit: BoxFit.contain),
                            ),
                            const SizedBox(width: 12),
                            Container(
                              padding: const EdgeInsets.all(4),
                              decoration: BoxDecoration(
                                color: Colors.white,
                                borderRadius: BorderRadius.circular(6),
                                border: Border.all(color: const Color(0xFFE2E8F0)),
                              ),
                              child: Image.asset('assets/IIT_tirupati_logo.png', height: 32, fit: BoxFit.contain),
                            ),
                            const SizedBox(width: 12),
                            Container(
                              padding: const EdgeInsets.all(4),
                              decoration: BoxDecoration(
                                color: Colors.white,
                                borderRadius: BorderRadius.circular(6),
                                border: Border.all(color: const Color(0xFFE2E8F0)),
                              ),
                              child: Image.asset('assets/ISRO_logo.png', height: 32, fit: BoxFit.contain),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                );
              },
            ),
          ),

          // Footers
          Positioned(
            bottom: 16,
            left: 24,
            child: FadeTransition(
              opacity: _subtitleFade,
              child: const Text(
                'VERSION 1.0.0',
                style: TextStyle(
                  fontSize: 9,
                  fontFamily: 'monospace',
                  color: Color(0x800B192C),
                ),
              ),
            ),
          ),
          Positioned(
            bottom: 16,
            right: 24,
            child: FadeTransition(
              opacity: _subtitleFade,
              child: const Text(
                '© ISRO PROJECT',
                style: TextStyle(
                  fontSize: 9,
                  fontFamily: 'monospace',
                  color: Color(0x800B192C),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

}

class _GridOverlayPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = AppColors.navy.withOpacity(0.03)
      ..strokeWidth = 1.0;

    const double step = 20.0;
    for (double x = 0; x < size.width; x += step) {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), paint);
    }
    for (double y = 0; y < size.height; y += step) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y), paint);
    }
  }

  @override
  bool shouldRepaint(covariant _GridOverlayPainter oldDelegate) => false;
}
