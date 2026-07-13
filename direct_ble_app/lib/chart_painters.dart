import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'dsp_engine.dart';
import 'theme/app_theme.dart';

// ═══════════════════════════════════════════════════════════════════════════════
// TIME DOMAIN PAINTER — Dark themed waveform oscilloscope
// ═══════════════════════════════════════════════════════════════════════════════

class TimeDomainPainter extends CustomPainter {
  final List<double> xData;
  final List<double> yData;
  final List<double> zData;
  final List<double> timeData;
  final double windowSeconds;
  final bool showX;
  final bool showY;
  final bool showZ;
  final bool autoScale;
  final double manualMinY;
  final double manualMaxY;

  final Color gridColor;
  final Color labelColor;
  final Color zeroLineColor;

  TimeDomainPainter({
    required this.xData,
    required this.yData,
    required this.zData,
    required this.timeData,
    required this.windowSeconds,
    required this.showX,
    required this.showY,
    required this.showZ,
    required this.autoScale,
    required this.manualMinY,
    required this.manualMaxY,
    this.gridColor = AppColors.gridLine,
    this.labelColor = AppColors.gridLabel,
    this.zeroLineColor = AppColors.zeroLine,
  });

  @override
  void paint(Canvas canvas, Size size) {
    if (timeData.isEmpty) return;

    final double w = size.width;
    final double h = size.height;

    const double paddingLeft = 45.0;
    const double paddingRight = 15.0;
    const double paddingTop = 15.0;
    const double paddingBottom = 25.0;

    final double chartWidth = w - paddingLeft - paddingRight;
    final double chartHeight = h - paddingTop - paddingBottom;

    if (chartWidth <= 0 || chartHeight <= 0) return;

    // 1. Determine time bounds
    final double tMax = timeData.last;
    final double tMin = math.max(0.0, tMax - windowSeconds);

    // Filter data indices within the window
    int startIdx = 0;
    while (startIdx < timeData.length && timeData[startIdx] < tMin) {
      startIdx++;
    }
    startIdx = math.max(0, startIdx - 1);

    if (startIdx >= timeData.length) return;

    // 2. Determine Y bounds
    double yMin = manualMinY;
    double yMax = manualMaxY;

    if (autoScale) {
      double minVal = double.infinity;
      double maxVal = -double.infinity;

      for (int i = startIdx; i < timeData.length; i++) {
        if (showX && i < xData.length) {
          if (xData[i] < minVal) minVal = xData[i];
          if (xData[i] > maxVal) maxVal = xData[i];
        }
        if (showY && i < yData.length) {
          if (yData[i] < minVal) minVal = yData[i];
          if (yData[i] > maxVal) maxVal = yData[i];
        }
        if (showZ && i < zData.length) {
          if (zData[i] < minVal) minVal = zData[i];
          if (zData[i] > maxVal) maxVal = zData[i];
        }
      }

      if (minVal != double.infinity && maxVal != -double.infinity) {
        final double range = maxVal - minVal;
        final double padding = math.max(range * 0.15, 0.01);
        yMin = minVal - padding;
        yMax = maxVal + padding;
      }
    }

    final double yRange = (yMax - yMin) == 0.0 ? 0.01 : (yMax - yMin);

    // 3. Draw Grid Lines & Axes
    final gridPaint = Paint()
      ..color = gridColor
      ..strokeWidth = 0.5;

    final axisPaint = Paint()
      ..color = zeroLineColor
      ..strokeWidth = 1.0;

    final labelStyle = TextStyle(color: labelColor, fontSize: 9.0, fontFamily: 'monospace', fontWeight: FontWeight.w600);

    // Horizontal grid lines (5 levels)
    for (int i = 0; i <= 4; i++) {
      final double dy = paddingTop + chartHeight * i / 4.0;
      canvas.drawLine(Offset(paddingLeft, dy), Offset(paddingLeft + chartWidth, dy), gridPaint);

      final double val = yMax - (yRange * i / 4.0);
      final textSpan = TextSpan(text: '${val.toStringAsFixed(2)}g', style: labelStyle);
      final textPainter = TextPainter(text: textSpan, textDirection: TextDirection.ltr)..layout();
      textPainter.paint(canvas, Offset(paddingLeft - textPainter.width - 6, dy - textPainter.height / 2));
    }

    // Vertical grid lines (5 steps)
    for (int i = 0; i <= 4; i++) {
      final double dx = paddingLeft + chartWidth * i / 4.0;
      canvas.drawLine(Offset(dx, paddingTop), Offset(dx, paddingTop + chartHeight), gridPaint);

      final double tVal = tMin + (windowSeconds * i / 4.0);
      final textSpan = TextSpan(text: '${tVal.toStringAsFixed(1)}s', style: labelStyle);
      final textPainter = TextPainter(text: textSpan, textDirection: TextDirection.ltr)..layout();
      textPainter.paint(canvas, Offset(dx - textPainter.width / 2, paddingTop + chartHeight + 4));
    }

    // Draw main axes border lines
    canvas.drawLine(Offset(paddingLeft, paddingTop), Offset(paddingLeft, paddingTop + chartHeight), axisPaint);
    canvas.drawLine(Offset(paddingLeft, paddingTop + chartHeight), Offset(paddingLeft + chartWidth, paddingTop + chartHeight), axisPaint);

    // Zero-line (if inside bounds)
    if (yMin < 0 && yMax > 0) {
      final zeroPaint = Paint()
        ..color = zeroLineColor.withOpacity(0.6)
        ..strokeWidth = 1.0;

      final double zeroY = paddingTop + chartHeight - ((0 - yMin) / yRange) * chartHeight;

      // Dashed line
      double dashX = paddingLeft;
      const double dashLen = 6.0;
      const double gapLen = 4.0;
      while (dashX < paddingLeft + chartWidth) {
        final end = math.min(dashX + dashLen, paddingLeft + chartWidth);
        canvas.drawLine(Offset(dashX, zeroY), Offset(end, zeroY), zeroPaint);
        dashX += dashLen + gapLen;
      }
    }

    // Clip paths to grid area
    canvas.save();
    canvas.clipRect(Rect.fromLTWH(paddingLeft, paddingTop, chartWidth, chartHeight));

    // 4. Draw Waveforms with glow effect
    void drawPath(List<double> channelData, Color color) {
      // Glow layer (thicker soft-colored background line)
      final glowPaint = Paint()
        ..color = color.withOpacity(0.12)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 3.0
        ..isAntiAlias = true;

      // Main line
      final pathPaint = Paint()
        ..color = color
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.5
        ..isAntiAlias = true;

      final Path path = Path();
      bool first = true;

      for (int i = startIdx; i < timeData.length && i < channelData.length; i++) {
        final double t = timeData[i];
        final double val = channelData[i];

        final double px = paddingLeft + ((t - tMin) / windowSeconds) * chartWidth;
        final double py = paddingTop + chartHeight - ((val - yMin) / yRange) * chartHeight;

        if (first) {
          path.moveTo(px, py);
          first = false;
        } else {
          path.lineTo(px, py);
        }
      }
      canvas.drawPath(path, glowPaint);
      canvas.drawPath(path, pathPaint);
    }

    if (showX) drawPath(xData, AppColors.axisX);
    if (showY) drawPath(yData, AppColors.axisY);
    if (showZ) drawPath(zData, AppColors.axisZ);

    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant TimeDomainPainter oldDelegate) {
    return oldDelegate.timeData.length != timeData.length ||
        oldDelegate.windowSeconds != windowSeconds ||
        oldDelegate.showX != showX ||
        oldDelegate.showY != showY ||
        oldDelegate.showZ != showZ ||
        oldDelegate.autoScale != autoScale ||
        oldDelegate.manualMinY != manualMinY ||
        oldDelegate.manualMaxY != manualMaxY;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FFT PAINTER — Dark themed spectrum analyzer with gradient fill
// ═══════════════════════════════════════════════════════════════════════════════

class FftPainter extends CustomPainter {
  final List<DspMagnitudePoint> magnitudes;
  final Color lineColor;
  final Color gridColor;
  final Color labelColor;
  final Color zeroLineColor;

  FftPainter({
    required this.magnitudes,
    required this.lineColor,
    this.gridColor = AppColors.gridLine,
    this.labelColor = AppColors.gridLabel,
    this.zeroLineColor = AppColors.zeroLine,
  });

  @override
  void paint(Canvas canvas, Size size) {
    if (magnitudes.isEmpty) return;

    final double w = size.width;
    final double h = size.height;

    const double paddingLeft = 45.0;
    const double paddingRight = 15.0;
    const double paddingTop = 15.0;
    const double paddingBottom = 25.0;

    final double chartWidth = w - paddingLeft - paddingRight;
    final double chartHeight = h - paddingTop - paddingBottom;

    if (chartWidth <= 0 || chartHeight <= 0) return;

    // 1. Find max magnitude for auto-scale
    double maxMag = 0.005;
    double peakFreq = 0.0;
    double peakVal = 0.0;

    for (var pt in magnitudes) {
      if (pt.magnitude > maxMag) {
        maxMag = pt.magnitude;
      }
      if (pt.magnitude > peakVal) {
        peakVal = pt.magnitude;
        peakFreq = pt.frequency;
      }
    }

    maxMag = maxMag * 1.1;

    final double fMin = magnitudes.first.frequency;
    final double fMax = magnitudes.last.frequency;
    final double fRange = (fMax - fMin) == 0.0 ? 1.0 : (fMax - fMin);

    // 2. Draw Grid Lines
    final gridPaint = Paint()
      ..color = gridColor
      ..strokeWidth = 0.5;

    final axisPaint = Paint()
      ..color = zeroLineColor
      ..strokeWidth = 1.0;

    final labelStyle = TextStyle(color: labelColor, fontSize: 9.0, fontFamily: 'monospace', fontWeight: FontWeight.w600);

    // Horizontal grids (5 levels)
    for (int i = 0; i <= 4; i++) {
      final double dy = paddingTop + chartHeight * i / 4.0;
      canvas.drawLine(Offset(paddingLeft, dy), Offset(paddingLeft + chartWidth, dy), gridPaint);

      final double val = maxMag - (maxMag * i / 4.0);
      final textSpan = TextSpan(text: '${val.toStringAsFixed(3)}g', style: labelStyle);
      final textPainter = TextPainter(text: textSpan, textDirection: TextDirection.ltr)..layout();
      textPainter.paint(canvas, Offset(paddingLeft - textPainter.width - 6, dy - textPainter.height / 2));
    }

    // Vertical grids (6 steps)
    for (int i = 0; i <= 5; i++) {
      final double dx = paddingLeft + chartWidth * i / 5.0;
      canvas.drawLine(Offset(dx, paddingTop), Offset(dx, paddingTop + chartHeight), gridPaint);

      final double fVal = fMin + (fRange * i / 5.0);
      final textSpan = TextSpan(text: '${fVal.toStringAsFixed(0)}Hz', style: labelStyle);
      final textPainter = TextPainter(text: textSpan, textDirection: TextDirection.ltr)..layout();
      textPainter.paint(canvas, Offset(dx - textPainter.width / 2, paddingTop + chartHeight + 4));
    }

    // Draw main axes border lines
    canvas.drawLine(Offset(paddingLeft, paddingTop), Offset(paddingLeft, paddingTop + chartHeight), axisPaint);
    canvas.drawLine(Offset(paddingLeft, paddingTop + chartHeight), Offset(paddingLeft + chartWidth, paddingTop + chartHeight), axisPaint);

    // Clip paths to grid area
    canvas.save();
    canvas.clipRect(Rect.fromLTWH(paddingLeft, paddingTop, chartWidth, chartHeight));

    // 3. Draw Magnitude Spectrum — gradient fill + line
    final Path linePath = Path();
    final Path areaPath = Path();

    areaPath.moveTo(paddingLeft, paddingTop + chartHeight);
    bool first = true;

    for (var pt in magnitudes) {
      final double px = paddingLeft + ((pt.frequency - fMin) / fRange) * chartWidth;
      final double py = paddingTop + chartHeight - (pt.magnitude / maxMag) * chartHeight;

      if (first) {
        linePath.moveTo(px, py);
        areaPath.lineTo(px, py);
        first = false;
      } else {
        linePath.lineTo(px, py);
        areaPath.lineTo(px, py);
      }
    }

    areaPath.lineTo(paddingLeft + chartWidth, paddingTop + chartHeight);
    areaPath.close();

    // Gradient fill under the curve
    final fillPaint = Paint()
      ..shader = LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: [
          lineColor.withOpacity(0.25),
          lineColor.withOpacity(0.02),
        ],
      ).createShader(Rect.fromLTWH(paddingLeft, paddingTop, chartWidth, chartHeight))
      ..style = PaintingStyle.fill;

    canvas.drawPath(areaPath, fillPaint);

    // Glow line
    final glowPaint = Paint()
      ..color = lineColor.withOpacity(0.2)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 4.0
      ..isAntiAlias = true
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 3);
    canvas.drawPath(linePath, glowPaint);

    // Main line
    final linePaint = Paint()
      ..color = lineColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5
      ..isAntiAlias = true;
    canvas.drawPath(linePath, linePaint);

    // 4. Highlight Peak Frequency Indicator
    if (peakVal > 0.0015) {
      final peakPx = paddingLeft + ((peakFreq - fMin) / fRange) * chartWidth;
      final peakPy = paddingTop + chartHeight - (peakVal / maxMag) * chartHeight;

      // Vertical indicator line
      final peakLinePaint = Paint()
        ..color = AppColors.warning.withOpacity(0.5)
        ..strokeWidth = 1.0
        ..style = PaintingStyle.stroke;
      canvas.drawLine(Offset(peakPx, paddingTop + chartHeight), Offset(peakPx, peakPy), peakLinePaint);

      // Peak dot with glow
      canvas.drawCircle(
        Offset(peakPx, peakPy),
        6,
        Paint()
          ..color = AppColors.warning.withOpacity(0.2)
          ..style = PaintingStyle.fill
          ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 4),
      );
      canvas.drawCircle(
        Offset(peakPx, peakPy),
        3.0,
        Paint()
          ..color = AppColors.warning
          ..style = PaintingStyle.fill,
      );
    }

    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant FftPainter oldDelegate) {
    return oldDelegate.magnitudes.length != magnitudes.length ||
        oldDelegate.lineColor != lineColor;
  }
}
