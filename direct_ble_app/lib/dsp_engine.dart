import 'dart:math' as math;
import 'dart:typed_data';

class DspMagnitudePoint {
  final double frequency;
  final double magnitude;

  DspMagnitudePoint({required this.frequency, required this.magnitude});
}

class DspEngine {
  // Bit-reversal helper for Cooley-Tukey FFT
  static int _reverseBits(int val, int bits) {
    int result = 0;
    int temp = val;
    for (int i = 0; i < bits; i++) {
      result = (result << 1) | (temp & 1);
      temp >>= 1;
    }
    return result;
  }

  // Cooley-Tukey Radix-2 FFT (Float64List for high precision)
  static void fftCooleyTukey(Float64List input, Float64List real, Float64List imag) {
    final n = input.length;
    final bits = (math.log(n) / math.log(2)).round();

    // Verify power of 2
    if (1 << bits != n) {
      throw ArgumentError('FFT size must be a power of 2, got: $n');
    }

    // Bit-reversal permutation
    for (int i = 0; i < n; i++) {
      final j = _reverseBits(i, bits);
      real[j] = input[i];
      imag[j] = 0.0;
    }

    // Cooley-Tukey iterative decimation-in-time
    for (int s = 1; s <= bits; s++) {
      final m = 1 << s;
      final wmReal = math.cos(-2.0 * math.pi / m);
      final wmImag = math.sin(-2.0 * math.pi / m);

      for (int k = 0; k < n; k += m) {
        double wReal = 1.0;
        double wImag = 0.0;

        for (int j = 0; j < m ~/ 2; j++) {
          final tReal = wReal * real[k + j + m ~/ 2] - wImag * imag[k + j + m ~/ 2];
          final tImag = wReal * imag[k + j + m ~/ 2] + wImag * real[k + j + m ~/ 2];

          final uReal = real[k + j];
          final uImag = imag[k + j];

          real[k + j] = uReal + tReal;
          imag[k + j] = uImag + tImag;
          real[k + j + m ~/ 2] = uReal - tReal;
          imag[k + j + m ~/ 2] = uImag - tImag;

          final newWReal = wReal * wmReal - wImag * wmImag;
          final newWImag = wReal * wmImag + wImag * wmReal;
          wReal = newWReal;
          wImag = newWImag;
        }
      }
    }
  }

  // Get Window multipliers
  static Float64List getWindow(String type, int n) {
    final w = Float64List(n);
    final normType = type.toLowerCase();
    
    switch (normType) {
      case 'hann':
        for (int i = 0; i < n; i++) {
          w[i] = 0.5 * (1.0 - math.cos(2.0 * math.pi * i / (n - 1)));
        }
        break;
      case 'hamming':
        for (int i = 0; i < n; i++) {
          w[i] = 0.54 - 0.46 * math.cos(2.0 * math.pi * i / (n - 1));
        }
        break;
      case 'blackman':
        for (int i = 0; i < n; i++) {
          w[i] = 0.42 - 0.5 * math.cos(2.0 * math.pi * i / (n - 1)) +
              0.08 * math.cos(4.0 * math.pi * i / (n - 1));
        }
        break;
      case 'blackman-harris':
        for (int i = 0; i < n; i++) {
          const a0 = 0.35875;
          const a1 = 0.48829;
          const a2 = 0.14128;
          const a3 = 0.01168;
          w[i] = a0 -
              a1 * math.cos(2.0 * math.pi * i / (n - 1)) +
              a2 * math.cos(4.0 * math.pi * i / (n - 1)) -
              a3 * math.cos(6.0 * math.pi * i / (n - 1));
        }
        break;
      case 'flat-top':
        for (int i = 0; i < n; i++) {
          const a0 = 0.21557895;
          const a1 = 0.41663158;
          const a2 = 0.277263158;
          const a3 = 0.083578947;
          const a4 = 0.006947368;
          w[i] = a0 -
              a1 * math.cos(2.0 * math.pi * i / (n - 1)) +
              a2 * math.cos(4.0 * math.pi * i / (n - 1)) -
              a3 * math.cos(6.0 * math.pi * i / (n - 1)) +
              a4 * math.cos(8.0 * math.pi * i / (n - 1));
        }
        break;
      default:
        w.fillRange(0, n, 1.0); // Rectangular (None)
    }
    return w;
  }

  // Compute Single-Sided Magnitude Spectrum with DC removal
  static List<DspMagnitudePoint> computeFFT({
    required List<double> rawSamples,
    required int fftSize,
    required double sampleRate,
    required String windowType,
  }) {
    if (rawSamples.length < fftSize) {
      return [];
    }

    // Slice last fftSize elements
    final int startIdx = rawSamples.length - fftSize;
    final List<double> subset = rawSamples.sublist(startIdx);

    // 1. DC Removal
    double sum = 0.0;
    for (int i = 0; i < fftSize; i++) {
      sum += subset[i];
    }
    final double mean = sum / fftSize;
    final Float64List centered = Float64List(fftSize);
    for (int i = 0; i < fftSize; i++) {
      centered[i] = subset[i] - mean;
    }

    // 2. Apply window
    final Float64List win = getWindow(windowType, fftSize);
    final Float64List windowed = Float64List(fftSize);
    for (int i = 0; i < fftSize; i++) {
      windowed[i] = centered[i] * win[i];
    }

    // 3. Compute FFT
    final Float64List real = Float64List(fftSize);
    final Float64List imag = Float64List(fftSize);
    fftCooleyTukey(windowed, real, imag);

    // 4. Compute single-sided magnitude spectrum
    final List<DspMagnitudePoint> magnitudes = [];
    final double freqBinSize = sampleRate / fftSize;
    
    // Single-sided spectrum goes up to N/2
    final int halfSize = fftSize ~/ 2;
    for (int k = 1; k < halfSize; k++) {
      final double freq = k * freqBinSize;
      // Single-sided scaling: multiply by 2/N
      final double mag = math.sqrt(real[k] * real[k] + imag[k] * imag[k]) * 2.0 / fftSize;
      magnitudes.add(DspMagnitudePoint(frequency: freq, magnitude: mag));
    }

    return magnitudes;
  }

  // Calculate dynamic Root Mean Square (RMS) of AC signal (detrended)
  static double calculateRms(List<double> slice) {
    if (slice.isEmpty) return 0.0;
    final double mean = slice.reduce((a, b) => a + b) / slice.length;
    double varianceSum = 0.0;
    for (int i = 0; i < slice.length; i++) {
      varianceSum += math.pow(slice[i] - mean, 2.0);
    }
    return math.sqrt(varianceSum / slice.length);
  }

  // Time-Domain Active SNR (in dB)
  static double calculateTimeSNR(double activeRms, double baselineNoise) {
    // Gating threshold: signal must exceed noise baseline by 5%
    if (activeRms <= baselineNoise * 1.05) {
      return 0.0;
    }
    // Subtract baseline noise power to extract signal energy
    final cleanSignalPower = math.max(0.0, activeRms * activeRms - baselineNoise * baselineNoise);
    final cleanSignal = math.sqrt(cleanSignalPower);
    return 20.0 * math.log(cleanSignal / baselineNoise) / math.ln10; // log10
  }

  // Frequency-Domain Spectral SNR (in dB)
  static double computeSpectralSNR(List<DspMagnitudePoint> magnitudes) {
    if (magnitudes.length < 20) return 0.0;

    // 1. Find peak carrier bin (ignoring DC drift below 5Hz)
    double peakMag = 0.0;
    int peakIdx = 0;

    final double freqResolution = magnitudes[1].frequency - magnitudes[0].frequency;
    final int startIdx = math.max(1, (5.0 / freqResolution).ceil()); // Skip < 5Hz

    for (int i = startIdx; i < magnitudes.length; i++) {
      final mag = magnitudes[i].magnitude;
      if (mag > peakMag) {
        peakMag = mag;
        peakIdx = i;
      }
    }

    // Gating: signal peak must exceed 1.5 mg (0.0015 g) to calculate carrier SNR
    if (peakMag < 0.0015) {
      return 0.0;
    }

    // 2. Sum power in Hann-window leak compensation window (peak ± 2 bins)
    double signalPower = 0.0;
    const int peakRange = 2;
    final int activePeakStart = math.max(0, peakIdx - peakRange);
    final int activePeakEnd = math.min(magnitudes.length - 1, peakIdx + peakRange);

    for (int i = activePeakStart; i <= activePeakEnd; i++) {
      signalPower += magnitudes[i].magnitude * magnitudes[i].magnitude;
    }

    // 3. Average remaining spectrum bins for unbiased noise power (excluding Low Freq & Peak Area)
    double noisePowerSum = 0.0;
    int noiseBinCount = 0;
    const int excludeRange = 5;
    final int excludeStart = peakIdx - excludeRange;
    final int excludeEnd = peakIdx + excludeRange;

    for (int i = startIdx; i < magnitudes.length; i++) {
      if (i >= excludeStart && i <= excludeEnd) {
        continue;
      }
      noisePowerSum += magnitudes[i].magnitude * magnitudes[i].magnitude;
      noiseBinCount++;
    }

    if (noiseBinCount == 0 || noisePowerSum == 0.0) return 0.0;
    final double averageNoisePower = noisePowerSum / noiseBinCount;

    // 4. SNR = 10 * log10(Signal Power / Noise Floor Power)
    final double ratio = signalPower / averageNoisePower;
    if (ratio <= 1.0) {
      return 0.0;
    }

    return 10.0 * math.log(ratio) / math.ln10; // log10
  }
}
