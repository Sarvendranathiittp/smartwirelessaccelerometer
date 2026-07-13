import 'dart:math' as math;
import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

// ═══════════════════════════════════════════════════════════════════════════════
// GLOWING CARD — Premium card with optional cyan/saffron glow border
// ═══════════════════════════════════════════════════════════════════════════════

class GlowingCard extends StatelessWidget {
  final Widget child;
  final Color glowColor;
  final EdgeInsets padding;
  final EdgeInsets? margin;
  final bool glow;

  const GlowingCard({
    super.key,
    required this.child,
    this.glowColor = AppColors.primary,
    this.padding = const EdgeInsets.all(12),
    this.margin,
    this.glow = false,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: margin,
      padding: padding,
      decoration: glow
          ? AppDecorations.glowCard(glowColor: glowColor)
          : AppDecorations.card(),
      child: child,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// METRIC TILE — Compact label + value + unit display
// ═══════════════════════════════════════════════════════════════════════════════

class MetricTile extends StatelessWidget {
  final String label;
  final String value;
  final String? unit;
  final Color? valueColor;
  final bool compact;

  const MetricTile({
    super.key,
    required this.label,
    required this.value,
    this.unit,
    this.valueColor,
    this.compact = false,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Text(
          label,
          style: AppTextStyles.labelSmall,
        ),
        const SizedBox(height: 2),
        RichText(
          text: TextSpan(
            children: [
              TextSpan(
                text: value,
                style: (compact ? AppTextStyles.mono : AppTextStyles.monoLarge).copyWith(
                  color: valueColor ?? AppColors.textPrimary,
                ),
              ),
              if (unit != null)
                TextSpan(
                  text: ' $unit',
                  style: AppTextStyles.monoSmall.copyWith(
                    color: AppColors.textTertiary,
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATUS BADGE — Colored pill indicator (Connected / Streaming / Idle)
// ═══════════════════════════════════════════════════════════════════════════════

class StatusBadge extends StatelessWidget {
  final String text;
  final Color color;
  final bool pulsing;

  const StatusBadge({
    super.key,
    required this.text,
    required this.color,
    this.pulsing = false,
  });

  factory StatusBadge.connected() => const StatusBadge(
        text: 'CONNECTED',
        color: AppColors.success,
      );

  factory StatusBadge.streaming() => const StatusBadge(
        text: 'STREAMING',
        color: AppColors.primary,
        pulsing: true,
      );

  factory StatusBadge.idle() => const StatusBadge(
        text: 'IDLE',
        color: AppColors.textTertiary,
      );

  factory StatusBadge.scanning() => const StatusBadge(
        text: 'SCANNING',
        color: AppColors.warning,
        pulsing: true,
      );

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: AppDecorations.badge(
        bgColor: color.withOpacity(0.12),
        borderColor: color.withOpacity(0.3),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(
              color: color,
              shape: BoxShape.circle,
              boxShadow: pulsing
                  ? [BoxShadow(color: color.withOpacity(0.6), blurRadius: 4, spreadRadius: 1)]
                  : null,
            ),
          ),
          const SizedBox(width: 5),
          Text(
            text,
            style: TextStyle(
              fontSize: 8,
              fontWeight: FontWeight.w700,
              color: color,
              letterSpacing: 0.8,
            ),
          ),
        ],
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CYBER BUTTON — Styled action button with gradient border
// ═══════════════════════════════════════════════════════════════════════════════

class CyberButton extends StatelessWidget {
  final String label;
  final IconData? icon;
  final VoidCallback? onPressed;
  final Color color;
  final bool filled;
  final bool compact;

  const CyberButton({
    super.key,
    required this.label,
    this.icon,
    this.onPressed,
    this.color = AppColors.primary,
    this.filled = true,
    this.compact = false,
  });

  @override
  Widget build(BuildContext context) {
    final bool enabled = onPressed != null;
    final double vPad = compact ? 8 : 12;

    if (filled) {
      return ElevatedButton(
        onPressed: onPressed,
        style: ElevatedButton.styleFrom(
          backgroundColor: enabled ? color : color.withOpacity(0.3),
          foregroundColor: Colors.white,
          disabledBackgroundColor: color.withOpacity(0.15),
          disabledForegroundColor: Colors.white38,
          padding: EdgeInsets.symmetric(horizontal: 16, vertical: vPad),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
          elevation: 0,
          textStyle: TextStyle(
            fontSize: compact ? 10 : 11,
            fontWeight: FontWeight.w700,
            letterSpacing: 0.5,
            inherit: false,
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            if (icon != null) ...[
              Icon(icon, size: compact ? 14 : 16),
              const SizedBox(width: 6),
            ],
            Text(label),
          ],
        ),
      );
    }

    return OutlinedButton(
      onPressed: onPressed,
      style: OutlinedButton.styleFrom(
        foregroundColor: enabled ? color : color.withOpacity(0.4),
        side: BorderSide(color: enabled ? color.withOpacity(0.4) : color.withOpacity(0.15)),
        padding: EdgeInsets.symmetric(horizontal: 16, vertical: vPad),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        textStyle: TextStyle(
          fontSize: compact ? 10 : 11,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.5,
          inherit: false,
        ),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          if (icon != null) ...[
            Icon(icon, size: compact ? 14 : 16),
            const SizedBox(width: 6),
          ],
          Text(label),
        ],
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RADAR SCANNER — Animated concentric circle scanner for scan screen
// ═══════════════════════════════════════════════════════════════════════════════

class RadarScanner extends StatefulWidget {
  final bool active;
  final double size;

  const RadarScanner({super.key, this.active = true, this.size = 200});

  @override
  State<RadarScanner> createState() => _RadarScannerState();
}

class _RadarScannerState extends State<RadarScanner> with SingleTickerProviderStateMixin {
  late AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 3),
    );
    if (widget.active) _controller.repeat();
  }

  @override
  void didUpdateWidget(RadarScanner oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.active && !_controller.isAnimating) {
      _controller.repeat();
    } else if (!widget.active && _controller.isAnimating) {
      _controller.stop();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: widget.size,
      height: widget.size,
      child: AnimatedBuilder(
        animation: _controller,
        builder: (context, child) {
          return CustomPaint(
            painter: _RadarPainter(
              progress: _controller.value,
              active: widget.active,
            ),
          );
        },
      ),
    );
  }
}

class _RadarPainter extends CustomPainter {
  final double progress;
  final bool active;

  _RadarPainter({required this.progress, required this.active});

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final maxRadius = size.width / 2;

    // Draw concentric rings
    final ringPaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 0.8;

    for (int i = 1; i <= 4; i++) {
      final r = maxRadius * i / 4;
      ringPaint.color = AppColors.primary.withOpacity(0.12 + (i == 4 ? 0.05 : 0));
      canvas.drawCircle(center, r, ringPaint);
    }

    // Draw crosshairs
    final crossPaint = Paint()
      ..color = AppColors.primary.withOpacity(0.08)
      ..strokeWidth = 0.5;
    canvas.drawLine(Offset(0, center.dy), Offset(size.width, center.dy), crossPaint);
    canvas.drawLine(Offset(center.dx, 0), Offset(center.dx, size.height), crossPaint);

    if (!active) return;

    // Rotating sweep arc
    final sweepAngle = progress * 2 * math.pi;
    final sweepPaint = Paint()
      ..shader = SweepGradient(
        center: Alignment.center,
        startAngle: sweepAngle - 0.8,
        endAngle: sweepAngle,
        colors: [
          AppColors.primary.withOpacity(0.0),
          AppColors.primary.withOpacity(0.25),
        ],
        tileMode: TileMode.clamp,
      ).createShader(Rect.fromCircle(center: center, radius: maxRadius))
      ..style = PaintingStyle.fill;

    canvas.save();
    canvas.clipPath(Path()..addOval(Rect.fromCircle(center: center, radius: maxRadius)));
    canvas.drawCircle(center, maxRadius, sweepPaint);
    canvas.restore();

    // Sweep line
    final lineEnd = Offset(
      center.dx + maxRadius * math.cos(sweepAngle - math.pi / 2),
      center.dy + maxRadius * math.sin(sweepAngle - math.pi / 2),
    );
    final linePaint = Paint()
      ..color = AppColors.primary.withOpacity(0.5)
      ..strokeWidth = 1.5;
    canvas.drawLine(center, lineEnd, linePaint);

    // Center dot
    final dotPaint = Paint()
      ..color = AppColors.primary
      ..style = PaintingStyle.fill;
    canvas.drawCircle(center, 3, dotPaint);
    canvas.drawCircle(center, 5, Paint()
      ..color = AppColors.primary.withOpacity(0.3)
      ..style = PaintingStyle.fill);
  }

  @override
  bool shouldRepaint(covariant _RadarPainter oldDelegate) {
    return oldDelegate.progress != progress || oldDelegate.active != active;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION HEADER — Sidebar/panel section label with optional action
// ═══════════════════════════════════════════════════════════════════════════════

class SectionHeader extends StatelessWidget {
  final String title;
  final Widget? trailing;

  const SectionHeader({super.key, required this.title, this.trailing});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(title, style: AppTextStyles.label),
        if (trailing != null) trailing!,
      ],
    );
  }
}
