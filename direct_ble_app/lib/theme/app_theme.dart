import 'package:flutter/material.dart';

/// ─────────────────────────────────────────────────────────────────────────────
/// ISRO Smart Wireless Accelerometer — Design System
/// Light Theme Matching the Desktop Dashboard Palette
/// ─────────────────────────────────────────────────────────────────────────────

class AppColors {
  AppColors._();

  // ── Core Palette ──────────────────────────────────────────────────────────
  static const Color background     = Color(0xFFF4F9FF); // Atmosphere Base / Workspace Background
  static const Color backgroundAlt  = Color(0xFFF8F9FB); // Secondary background
  static const Color surface        = Color(0xFFFFFFFF); // Elevated Surface / Panels
  static const Color surfaceHigh    = Color(0xFFFFFFFF); // Cards / Popups
  static const Color surfaceBright  = Color(0xFFE0F4FF); // Telemetry light blue highlight

  // ── Accent Colors ─────────────────────────────────────────────────────────
  static const Color primary        = Color(0xFF00A3E0); // Telemetry Cyan
  static const Color primaryDim     = Color(0xFF008CC0);
  static const Color primaryGlow    = Color(0x2200A3E0); // 13% opacity glow
  static const Color saffron        = Color(0xFFFF671F); // ISRO Saffron
  static const Color saffronDim     = Color(0xFFE05615);
  static const Color navy           = Color(0xFF0B192C); // Deep Space Navy

  // ── Semantic Colors ───────────────────────────────────────────────────────
  static const Color success        = Color(0xFF10B981); // Emerald
  static const Color successBg      = Color(0xFFF0FDF4); // Light Emerald Bg
  static const Color warning        = Color(0xFFF59E0B); // Amber
  static const Color warningBg      = Color(0xFFFFFBEB); // Light Amber Bg
  static const Color error          = Color(0xFFEF4444); // Red
  static const Color errorBg        = Color(0xFFFEF2F2); // Light Red Bg

  // ── Chart Axis Colors ─────────────────────────────────────────────────────
  static const Color axisX          = Color(0xFFFF4D6D); // Coral Red
  static const Color axisY          = Color(0xFF10B981); // Emerald Green
  static const Color axisZ          = Color(0xFF6366F1); // Indigo/Blue

  // ── Text Colors ───────────────────────────────────────────────────────────
  static const Color textPrimary    = Color(0xFF0B192C); // Deep Space Navy
  static const Color textSecondary  = Color(0xFF475569); // Slate 600
  static const Color textTertiary   = Color(0xFF64748B); // Slate 500
  static const Color textMuted      = Color(0xFF94A3B8); // Slate 400

  // ── Border / Divider ──────────────────────────────────────────────────────
  static const Color border         = Color(0xFFE2E8F0); // Slate 200
  static const Color borderLight    = Color(0xFFF1F5F9); // Slate 100
  static const Color divider        = Color(0xFFE2E8F0);

  // ── Grid / Chart Lines ────────────────────────────────────────────────────
  static const Color gridLine       = Color(0x0F94A3B8); // 6% Slate (rgba(148,163,184,0.06))
  static const Color gridLabel      = Color(0xFF64748B);
  static const Color zeroLine       = Color(0xFFCBD5E1);
}

class AppTextStyles {
  AppTextStyles._();

  // ── Headings ──────────────────────────────────────────────────────────────
  static const TextStyle h1 = TextStyle(
    fontSize: 22,
    fontWeight: FontWeight.w800,
    color: AppColors.textPrimary,
    letterSpacing: -0.5,
    height: 1.2,
  );

  static const TextStyle h2 = TextStyle(
    fontSize: 16,
    fontWeight: FontWeight.w700,
    color: AppColors.textPrimary,
    letterSpacing: -0.3,
  );

  static const TextStyle h3 = TextStyle(
    fontSize: 13,
    fontWeight: FontWeight.w700,
    color: AppColors.textPrimary,
    letterSpacing: 0.2,
  );

  // ── Body ──────────────────────────────────────────────────────────────────
  static const TextStyle body = TextStyle(
    fontSize: 12,
    fontWeight: FontWeight.w500,
    color: AppColors.textSecondary,
    height: 1.4,
  );

  static const TextStyle bodySmall = TextStyle(
    fontSize: 11,
    fontWeight: FontWeight.w500,
    color: AppColors.textSecondary,
  );

  // ── Labels ────────────────────────────────────────────────────────────────
  static const TextStyle label = TextStyle(
    fontSize: 10,
    fontWeight: FontWeight.w700,
    color: AppColors.textTertiary,
    letterSpacing: 1.5,
  );

  static const TextStyle labelSmall = TextStyle(
    fontSize: 8,
    fontWeight: FontWeight.w700,
    color: AppColors.textMuted,
    letterSpacing: 1.2,
  );

  // ── Monospace ─────────────────────────────────────────────────────────────
  static const TextStyle mono = TextStyle(
    fontSize: 12,
    fontWeight: FontWeight.w600,
    color: AppColors.textPrimary,
    fontFamily: 'monospace',
  );

  static const TextStyle monoSmall = TextStyle(
    fontSize: 10,
    fontWeight: FontWeight.w600,
    color: AppColors.textSecondary,
    fontFamily: 'monospace',
  );

  static const TextStyle monoLarge = TextStyle(
    fontSize: 18,
    fontWeight: FontWeight.w700,
    color: AppColors.primary,
    fontFamily: 'monospace',
  );

  // ── Value Display ─────────────────────────────────────────────────────────
  static const TextStyle valueDisplay = TextStyle(
    fontSize: 14,
    fontWeight: FontWeight.w800,
    fontFamily: 'monospace',
    height: 1.0,
  );
}

class AppDecorations {
  AppDecorations._();

  /// Standard card decoration with subtle border
  static BoxDecoration card({Color? color, Color? borderColor}) {
    return BoxDecoration(
      color: color ?? AppColors.surfaceHigh,
      borderRadius: BorderRadius.circular(10),
      border: Border.all(color: borderColor ?? AppColors.border, width: 1),
      boxShadow: [
        BoxShadow(
          color: Colors.black.withOpacity(0.02),
          blurRadius: 4,
          offset: const Offset(0, 2),
        ),
      ],
    );
  }

  /// Glowing card with primary accent border
  static BoxDecoration glowCard({Color glowColor = AppColors.primary}) {
    return BoxDecoration(
      color: AppColors.surfaceHigh,
      borderRadius: BorderRadius.circular(10),
      border: Border.all(color: glowColor.withOpacity(0.3), width: 1.2),
      boxShadow: [
        BoxShadow(
          color: glowColor.withOpacity(0.04),
          blurRadius: 10,
          spreadRadius: 0,
          offset: const Offset(0, 2),
        ),
      ],
    );
  }

  /// Surface panel (sidebar, headers)
  static BoxDecoration panel({Color? color}) {
    return BoxDecoration(
      color: color ?? AppColors.surface,
      border: Border.all(color: AppColors.border, width: 1),
    );
  }

  /// Status badge pill
  static BoxDecoration badge({required Color bgColor, required Color borderColor}) {
    return BoxDecoration(
      color: bgColor,
      borderRadius: BorderRadius.circular(4),
      border: Border.all(color: borderColor, width: 1),
    );
  }

  /// Chart container
  static BoxDecoration chartContainer() {
    return BoxDecoration(
      color: AppColors.surface,
      borderRadius: BorderRadius.circular(8),
      border: Border.all(color: AppColors.border, width: 1),
    );
  }
}
