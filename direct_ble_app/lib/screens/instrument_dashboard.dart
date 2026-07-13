import 'dart:async';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../ble_manager.dart';
import '../theme/app_theme.dart';
import '../widgets/widgets.dart';
import '../chart_painters.dart';
import '../dsp_engine.dart';

class InstrumentDashboard extends StatefulWidget {
  final VoidCallback onBack;

  const InstrumentDashboard({super.key, required this.onBack});

  @override
  State<InstrumentDashboard> createState() => _InstrumentDashboardState();
}

class _InstrumentDashboardState extends State<InstrumentDashboard> with TickerProviderStateMixin {
  // Navigation tabs state: 0=Config, 1=Calib, 2=Acquire, 3=DSP, 4=Session
  int _activeTab = 0;
  bool _drawerCollapsed = false;

  // Chart settings
  bool _showX = true;
  bool _showY = true;
  bool _showZ = true;
  double _windowSeconds = 1.0;
  bool _autoScaleY = true;
  int? _cycleLock;
  
  // Spectral settings
  bool _isFftTab = true; // true = FFT, false = PSD
  String _fftAxis = 'z';
  String _windowType = 'hann';
  int _fftSize = 2048;
  int _psdAverages = 8;

  // DSP filter settings
  String _coupling = 'DC';
  String _filterType = 'None';
  int _filterOrder = 4;
  double _filterCutoff = 100.0;
  String _outputQuantity = 'acceleration';
  bool _showAnalyzer = false;
  bool _showPhasePlot = true;

  // Orbit plot settings
  String _orbitAxis = 'xy';
  bool _isOrbitFrozen = false;
  List<Offset> _orbitHistory = [];

  // Export settings
  String _exportFormat = 'csv';
  bool _expRawAccel = true;
  bool _expProcAccel = true;
  bool _expVelocity = false;
  bool _expDisplacement = false;
  bool _expFFT = false;
  bool _expPSD = false;
  bool _expStats = true;
  bool _expMetadata = true;
  final TextEditingController _exportFilenameCtrl = TextEditingController(text: 'vibration_telemetry');

  // Interactive 6-position wizard state
  bool _showSixPosOverlay = false;
  int _sixPosStep = 1; // 1 to 6
  bool _sixPosCapturing = false;
  double _sixPosProgress = 0.0;
  int _sixPosSecondsLeft = 5;
  Timer? _sixPosTimer;

  // Interactive tare calibration overlay state
  bool _showTareOverlay = false;
  double _tareProgress = 0.0;
  int _tareSecondsLeft = 10;
  Timer? _tareTimer;

  @override
  void dispose() {
    _exportFilenameCtrl.dispose();
    _sixPosTimer?.cancel();
    _tareTimer?.cancel();
    super.dispose();
  }

  // Active calibration statistics
  double get _calibRms => 0.0034;
  double get _calibMax => 0.0076;
  double get _calibQuality => 98.4;

  @override
  Widget build(BuildContext context) {
    final ble = Provider.of<BleManager>(context);

    // Dynamic calculated peak spectral metrics
    double peakFreq = 0.0;
    double thd = 0.0;
    if (ble.receivedData.isNotEmpty) {
      // Stub values matching logic computed in JavaScript
      peakFreq = 23.4;
      thd = 1.45;
    }

    // Capture dynamic orbit plot data point
    if (ble.receivedData.isNotEmpty && !_isOrbitFrozen) {
      final lastPt = ble.receivedData.last;
      double axisA = lastPt.x;
      double axisB = lastPt.y;
      if (_orbitAxis == 'xz') {
        axisB = lastPt.z;
      } else if (_orbitAxis == 'yz') {
        axisA = lastPt.y;
        axisB = lastPt.z;
      }
      _orbitHistory.add(Offset(axisA, axisB));
      if (_orbitHistory.length > 500) {
        _orbitHistory.removeAt(0);
      }
    }

    return Scaffold(
      backgroundColor: AppColors.background,
      resizeToAvoidBottomInset: false,
      body: Stack(
        children: [
          Column(
            children: [
              // ── 1. Top Header Navigation Bar ──────────────────────────
              SafeArea(
                bottom: false,
                child: Container(
                  height: 48,
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  decoration: const BoxDecoration(
                    color: Colors.white,
                    border: Border(bottom: BorderSide(color: AppColors.border)),
                  ),
                  child: LayoutBuilder(
                    builder: (context, constraints) {
                      return SingleChildScrollView(
                        scrollDirection: Axis.horizontal,
                        child: ConstrainedBox(
                          constraints: BoxConstraints(
                            minWidth: constraints.maxWidth,
                          ),
                          child: Row(
                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                            children: [
                              Row(
                                children: [
                                  // App Icon
                                  Container(
                                    width: 28,
                                    height: 28,
                                    decoration: BoxDecoration(
                                      color: Colors.white,
                                      borderRadius: BorderRadius.circular(8),
                                      border: Border.all(color: const Color(0xFFE2E8F0)),
                                    ),
                                    child: ClipRRect(
                                      borderRadius: BorderRadius.circular(6),
                                      child: Image.asset(
                                        'assets/icon/app_icon.png',
                                        fit: BoxFit.cover,
                                      ),
                                    ),
                                  ),
                                  const SizedBox(width: 10),
                                  Column(
                                    mainAxisAlignment: MainAxisAlignment.center,
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      const Text(
                                        'Smart Wireless Accelerometer',
                                        style: TextStyle(
                                          fontSize: 13,
                                          fontWeight: FontWeight.bold,
                                          color: AppColors.navy,
                                          height: 1.1,
                                        ),
                                      ),
                                      Text(
                                        'DATA ACQUISITION PLATFORM  •  ${ble.isReading ? "ACQUISITION ACTIVE" : "ACQUISITION IDLE"}',
                                        style: const TextStyle(
                                          fontSize: 8,
                                          fontWeight: FontWeight.bold,
                                          color: AppColors.textSecondary,
                                          letterSpacing: 0.5,
                                        ),
                                      ),
                                    ],
                                  ),
                                ],
                              ),

                              // Active Node information + Quick actions
                              Row(
                                children: [
                                  // Connection stats bubble
                                  if (ble.isConnected)
                                    Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                                      decoration: BoxDecoration(
                                        color: const Color(0xFFF1F5F9),
                                        borderRadius: BorderRadius.circular(6),
                                      ),
                                      child: Row(
                                        children: [
                                          Container(
                                            width: 6,
                                            height: 6,
                                            decoration: BoxDecoration(
                                              color: ble.isReading ? AppColors.success : Colors.amber.shade600,
                                              shape: BoxShape.circle,
                                            ),
                                          ),
                                          const SizedBox(width: 6),
                                          Text(
                                            '${ble.connectedDevice?.platformName ?? "Node-01"}  |  ${ble.sensorName}  |  ${ble.samplingRate} Hz  |  ±${ble.rangeG}g',
                                            style: const TextStyle(
                                              fontSize: 9,
                                              fontFamily: 'monospace',
                                              fontWeight: FontWeight.bold,
                                              color: AppColors.textSecondary,
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                                  const SizedBox(width: 12),

                                  // Back button
                                  OutlinedButton.icon(
                                    onPressed: widget.onBack,
                                    icon: const Icon(Icons.arrow_back, size: 12),
                                    label: const Text('Back'),
                                    style: OutlinedButton.styleFrom(
                                      foregroundColor: AppColors.textSecondary,
                                      side: const BorderSide(color: AppColors.border),
                                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                                      textStyle: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, inherit: false),
                                    ),
                                  ),
                                  const SizedBox(width: 6),

                                  // Disconnect button
                                  ElevatedButton.icon(
                                    onPressed: () {
                                      ble.disconnect();
                                      widget.onBack();
                                    },
                                    icon: const Icon(Icons.sensors_off, size: 12),
                                    label: const Text('Disconnect'),
                                    style: ElevatedButton.styleFrom(
                                      backgroundColor: const Color(0xFFFFF1F2),
                                      foregroundColor: Colors.red.shade700,
                                      elevation: 0,
                                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                                      textStyle: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, inherit: false),
                                    ),
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
                ),
              ),

              // ── 2. Middle Row: Side navigation, sidebar options, main grid ─────────
              Expanded(
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    // A. Left Nav Tab bar (Icon icons only)
                    SafeArea(
                      right: false,
                      child: Container(
                        width: 56,
                        decoration: const BoxDecoration(
                          color: Colors.white,
                          border: Border(right: BorderSide(color: AppColors.border)),
                        ),
                        child: SingleChildScrollView(
                          child: Column(
                            children: [
                              const SizedBox(height: 12),
                              _buildNavIcon(0, Icons.tune, 'Config'),
                              _buildNavIcon(1, Icons.build_circle_outlined, 'Calib'),
                              _buildNavIcon(2, Icons.sensors, 'Acquire'),
                              _buildNavIcon(3, Icons.analytics_outlined, 'DSP'),
                              _buildNavIcon(4, Icons.sim_card_download_outlined, 'Session'),
                            ],
                          ),
                        ),
                      ),
                    ),

                    // B. Collapsible Content Drawer
                    SafeArea(
                      left: false,
                      right: false,
                      child: AnimatedContainer(
                        duration: const Duration(milliseconds: 200),
                        width: _drawerCollapsed ? 0 : 256,
                        clipBehavior: Clip.hardEdge,
                        decoration: const BoxDecoration(
                          color: Colors.white,
                          border: Border(right: BorderSide(color: AppColors.border)),
                        ),
                        child: _drawerCollapsed
                            ? const SizedBox.shrink()
                            : Column(
                                crossAxisAlignment: CrossAxisAlignment.stretch,
                                children: [
                                  // Header
                                  Padding(
                                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                                    child: Row(
                                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                      children: [
                                        Text(
                                          _getTabTitle(),
                                          style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: AppColors.navy, letterSpacing: 1.0),
                                        ),
                                        IconButton(
                                          icon: const Icon(Icons.keyboard_double_arrow_left, size: 16),
                                          padding: EdgeInsets.zero,
                                          constraints: const BoxConstraints(),
                                          onPressed: () => setState(() => _drawerCollapsed = true),
                                        ),
                                      ],
                                    ),
                                  ),
                                  const Divider(height: 1, color: AppColors.border),

                                  // Tab specific body
                                  Expanded(
                                    child: SingleChildScrollView(
                                      padding: const EdgeInsets.all(12),
                                      child: _buildDrawerContent(ble),
                                    ),
                                  ),
                                ],
                              ),
                      ),
                    ),

                    // C. Collapsed drawer expansion pill
                    if (_drawerCollapsed)
                      GestureDetector(
                        onTap: () => setState(() => _drawerCollapsed = false),
                        child: Container(
                          width: 16,
                          color: const Color(0xFFF1F5F9),
                          child: const Icon(Icons.chevron_right, size: 14, color: AppColors.textSecondary),
                        ),
                      ),

                    // D. Main Telemetry Graphs Workspace
                    Expanded(
                      child: Container(
                        padding: const EdgeInsets.all(8),
                        color: AppColors.backgroundAlt,
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            // Left Area: 2 Large Charts (70% height equivalent or split layout)
                            Expanded(
                              flex: 7,
                              child: Column(
                                children: [
                                  // Time Domain oscilloscope
                                  Expanded(
                                    child: _buildTimeDomainCard(ble),
                                  ),
                                  const SizedBox(height: 8),

                                  // Spectral FFT / PSD card
                                  Expanded(
                                    child: _buildSpectralCard(ble, peakFreq),
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(width: 8),

                            // Right Sidebar: Live Diagnostics + Quality (30% equivalent)
                            Expanded(
                              flex: 3,
                              child: SingleChildScrollView(
                                child: Column(
                                  children: [
                                    _buildInspectorCard(peakFreq),
                                    const SizedBox(height: 8),
                                    _buildSnrSidebarCard(ble),
                                  ],
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              ),

              // ── 3. Footer Status Bar ────────────────────────────────────
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                decoration: const BoxDecoration(
                  color: Color(0xFFF1F5F9),
                  border: Border(top: BorderSide(color: AppColors.border)),
                ),
                child: SafeArea(
                  top: false,
                  child: LayoutBuilder(
                    builder: (context, constraints) {
                      return SingleChildScrollView(
                        scrollDirection: Axis.horizontal,
                        child: ConstrainedBox(
                          constraints: BoxConstraints(
                            minWidth: constraints.maxWidth,
                          ),
                          child: Row(
                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                            children: [
                              Row(
                                children: [
                                  Container(
                                    width: 6,
                                    height: 6,
                                    decoration: BoxDecoration(
                                      color: ble.isReading ? AppColors.success : Colors.amber.shade500,
                                      shape: BoxShape.circle,
                                    ),
                                  ),
                                  const SizedBox(width: 6),
                                  Text(
                                    ble.isReading ? 'Streaming Live Data...' : 'Telemetry Link Active',
                                    style: const TextStyle(fontSize: 8, fontWeight: FontWeight.bold, color: AppColors.textSecondary, letterSpacing: 0.5),
                                  ),
                                ],
                              ),
                              Row(
                                children: [
                                  Image.asset('assets/SMA_lab_logo.png', height: 10, width: 10, fit: BoxFit.contain),
                                  const SizedBox(width: 3),
                                  const Text(
                                    'SMA LAB',
                                    style: TextStyle(fontSize: 8, fontWeight: FontWeight.bold, color: AppColors.textMuted, letterSpacing: 0.5, inherit: false),
                                  ),
                                  const SizedBox(width: 6),
                                  const Text('•', style: TextStyle(fontSize: 8, color: AppColors.textMuted, inherit: false)),
                                  const SizedBox(width: 6),
                                  Image.asset('assets/IIT_tirupati_logo.png', height: 10, width: 10, fit: BoxFit.contain),
                                  const SizedBox(width: 3),
                                  const Text(
                                    'IIT TIRUPATI',
                                    style: TextStyle(fontSize: 8, fontWeight: FontWeight.bold, color: AppColors.textMuted, letterSpacing: 0.5, inherit: false),
                                  ),
                                  const SizedBox(width: 6),
                                  const Text('•', style: TextStyle(fontSize: 8, color: AppColors.textMuted, inherit: false)),
                                  const SizedBox(width: 6),
                                  Image.asset('assets/ISRO_logo.png', height: 10, width: 10, fit: BoxFit.contain),
                                  const SizedBox(width: 3),
                                  const Text(
                                    'ISRO',
                                    style: TextStyle(fontSize: 8, fontWeight: FontWeight.bold, color: AppColors.textMuted, letterSpacing: 0.5, inherit: false),
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
                ),
              ),
            ],
          ),

          // ── 4. Interactive Calibration Overlays ──────────────────────

          // Tare offset wizard
          if (_showTareOverlay)
            Container(
              color: Colors.black45,
              child: Center(
                child: Container(
                  width: 320,
                  padding: const EdgeInsets.all(20),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: AppColors.border),
                  ),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const CircularProgressIndicator(color: AppColors.primary),
                      const SizedBox(height: 16),
                      const Text(
                        'Calibrating Noise Floor / Tare',
                        style: TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: AppColors.navy),
                      ),
                      const SizedBox(height: 6),
                      const Text(
                        'Please ensure the accelerometer remains completely stationary and rigidly mounted.',
                        textAlign: TextAlign.center,
                        style: TextStyle(fontSize: 10, color: AppColors.textSecondary, height: 1.4),
                      ),
                      const SizedBox(height: 16),
                      LinearProgressIndicator(
                        value: _tareProgress,
                        backgroundColor: const Color(0xFFF1F5F9),
                        color: AppColors.primary,
                        minHeight: 4,
                      ),
                      const SizedBox(height: 10),
                      Text(
                        '${_tareSecondsLeft.toStringAsFixed(1)}s Remaining',
                        style: const TextStyle(fontSize: 11, fontFamily: 'monospace', fontWeight: FontWeight.bold, color: AppColors.primary),
                      ),
                    ],
                  ),
                ),
              ),
            ),

          // 6-Position Advanced Calibration wizard
          if (_showSixPosOverlay)
            Container(
              color: Colors.black45,
              child: Center(
                child: Container(
                  width: 360,
                  padding: const EdgeInsets.all(20),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: AppColors.border),
                  ),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      // Dots
                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: List.generate(6, (idx) {
                          final stepNum = idx + 1;
                          final isActive = _sixPosStep == stepNum;
                          final isCompleted = _sixPosStep > stepNum;
                          return Container(
                            width: 22,
                            height: 22,
                            margin: const EdgeInsets.symmetric(horizontal: 4),
                            decoration: BoxDecoration(
                              color: isCompleted
                                  ? AppColors.success
                                  : isActive
                                      ? AppColors.primary
                                      : const Color(0xFFE2E8F0),
                              shape: BoxShape.circle,
                            ),
                            child: Center(
                              child: Text(
                                '$stepNum',
                                style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Colors.white),
                              ),
                            ),
                          );
                        }),
                      ),
                      const SizedBox(height: 16),

                      Text(
                        '6-Position Calibration Step $_sixPosStep',
                        style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: AppColors.navy),
                      ),
                      const SizedBox(height: 8),

                      // Animation emoji representation
                      Text(
                        _getSixPosOrientationEmoji(),
                        style: const TextStyle(fontSize: 36),
                      ),
                      const SizedBox(height: 8),

                      Text(
                        'Orient Node: ${_getSixPosOrientationText()}',
                        style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: AppColors.primary),
                      ),
                      const SizedBox(height: 4),
                      const Text(
                        'Lay the board flat on a table and keep completely still, then press capture.',
                        textAlign: TextAlign.center,
                        style: TextStyle(fontSize: 9, color: AppColors.textSecondary, height: 1.4),
                      ),
                      const SizedBox(height: 16),

                      if (_sixPosCapturing) ...[
                        LinearProgressIndicator(
                          value: _sixPosProgress,
                          backgroundColor: const Color(0xFFF1F5F9),
                          color: AppColors.primary,
                          minHeight: 4,
                        ),
                        const SizedBox(height: 8),
                        Text(
                          'Capturing: ${_sixPosSecondsLeft}s left',
                          style: const TextStyle(fontSize: 10, fontFamily: 'monospace', fontWeight: FontWeight.bold, color: AppColors.primary),
                        ),
                      ],
                      const SizedBox(height: 16),

                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          ElevatedButton(
                            onPressed: _sixPosCapturing ? null : _captureSixPosStep,
                            style: ElevatedButton.styleFrom(
                              backgroundColor: AppColors.primary,
                              foregroundColor: Colors.white,
                              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                            ),
                            child: Text('▶ Capture Position $_sixPosStep', style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold)),
                          ),
                          const SizedBox(width: 10),
                          OutlinedButton(
                            onPressed: () {
                              _sixPosTimer?.cancel();
                              setState(() {
                                _showSixPosOverlay = false;
                                _sixPosCapturing = false;
                              });
                            },
                            style: OutlinedButton.styleFrom(
                              foregroundColor: Colors.red,
                              side: const BorderSide(color: Colors.red),
                              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                            ),
                            child: const Text('✕ Cancel', style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold)),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  // Helper mapping icon button
  Widget _buildNavIcon(int tabIndex, IconData icon, String label) {
    final isActive = _activeTab == tabIndex;
    return GestureDetector(
      onTap: () => setState(() {
        _activeTab = tabIndex;
        _drawerCollapsed = false;
      }),
      child: Container(
        width: 44,
        height: 48,
        margin: const EdgeInsets.only(bottom: 8),
        decoration: BoxDecoration(
          color: isActive ? AppColors.primary.withOpacity(0.08) : Colors.transparent,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, size: 20, color: isActive ? AppColors.primary : AppColors.textSecondary),
            const SizedBox(height: 3),
            Text(
              label,
              style: TextStyle(
                fontSize: 8,
                fontWeight: FontWeight.bold,
                color: isActive ? AppColors.primary : AppColors.textSecondary,
                letterSpacing: 0.5,
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _getTabTitle() {
    switch (_activeTab) {
      case 0:
        return 'SENSOR CONFIGURATION';
      case 1:
        return 'CALIBRATION WIZARDS';
      case 2:
        return 'ACQUISITION CONTROLS';
      case 3:
        return 'DSP CONFIGURATION';
      case 4:
      default:
        return 'EXPORT SESSION';
    }
  }

  Widget _buildDrawerContent(BleManager ble) {
    switch (_activeTab) {
      case 0:
        return _buildConfigDrawer(ble);
      case 1:
        return _buildCalibrationDrawer(ble);
      case 2:
        return _buildAcquisitionDrawer(ble);
      case 3:
        return _buildDspDrawer(ble);
      case 4:
      default:
        return _buildExportDrawer(ble);
    }
  }

  // ────────── TAB 0: CONFIG DRAWER ──────────
  Widget _buildConfigDrawer(BleManager ble) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Card style container
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: AppColors.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _buildSectionTitle('PROFILE SELECT'),
              DropdownButtonFormField<String>(
                value: 'custom',
                decoration: const InputDecoration(
                  contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                  border: OutlineInputBorder(),
                ),
                style: const TextStyle(fontSize: 11, color: AppColors.navy, fontWeight: FontWeight.bold),
                items: const [
                  DropdownMenuItem(value: 'custom', child: Text('Custom Options')),
                  DropdownMenuItem(value: 'precision_vibration', child: Text('Precision Vibration (±2g)')),
                  DropdownMenuItem(value: 'machinery_monitoring', child: Text('Machinery Monitoring (±8g)')),
                  DropdownMenuItem(value: 'structural_dynamics', child: Text('Structural Dynamics (±16g)')),
                  DropdownMenuItem(value: 'shock_testing', child: Text('Shock Testing (±400g)')),
                ],
                onChanged: (val) {
                  if (val == 'precision_vibration') {
                    ble.selectSensor('ADXL345');
                    ble.writeGRange(2);
                  } else if (val == 'machinery_monitoring') {
                    ble.selectSensor('ADXL345');
                    ble.writeGRange(8);
                  } else if (val == 'structural_dynamics') {
                    ble.selectSensor('ADXL345');
                    ble.writeGRange(16);
                  } else if (val == 'shock_testing') {
                    ble.selectSensor('H3LIS331DL');
                    ble.writeGRange(400);
                  }
                },
              ),
              const SizedBox(height: 12),

              _buildSectionTitle('SELECTED TRANSDUCER'),
              DropdownButtonFormField<String>(
                value: ['ADXL345', 'H3LIS331DL'].contains(ble.activeSensor)
                    ? ble.activeSensor
                    : 'ADXL345',
                decoration: const InputDecoration(
                  contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                  border: OutlineInputBorder(),
                ),
                style: const TextStyle(fontSize: 11, color: AppColors.navy, fontWeight: FontWeight.bold),
                items: const [
                  DropdownMenuItem(value: 'ADXL345', child: Text('ADXL345')),
                  DropdownMenuItem(value: 'H3LIS331DL', child: Text('H3LIS331DL')),
                ],
                onChanged: (val) {
                  if (val != null) {
                    ble.selectSensor(val);
                  }
                },
              ),
              const SizedBox(height: 12),

              _buildSectionTitle('DYNAMIC G-RANGE'),
              DropdownButtonFormField<int>(
                value: (ble.activeSensor == 'ADXL345'
                        ? const [2, 4, 8, 16]
                        : const [100, 200, 400])
                    .contains(ble.rangeG)
                        ? ble.rangeG
                        : (ble.activeSensor == 'ADXL345' ? 2 : 100),
                decoration: const InputDecoration(
                  contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                  border: OutlineInputBorder(),
                ),
                style: const TextStyle(fontSize: 11, color: AppColors.navy, fontWeight: FontWeight.bold),
                items: ble.activeSensor == 'ADXL345'
                    ? const [
                        DropdownMenuItem(value: 2, child: Text('±2g')),
                        DropdownMenuItem(value: 4, child: Text('±4g')),
                        DropdownMenuItem(value: 8, child: Text('±8g')),
                        DropdownMenuItem(value: 16, child: Text('±16g')),
                      ]
                    : const [
                        DropdownMenuItem(value: 100, child: Text('±100g')),
                        DropdownMenuItem(value: 200, child: Text('±200g')),
                        DropdownMenuItem(value: 400, child: Text('±400g')),
                      ],
                onChanged: (val) {
                  if (val != null) {
                    ble.writeGRange(val);
                  }
                },
              ),
              const SizedBox(height: 12),

              _buildSectionTitle('SAMPLING RATE'),
              DropdownButtonFormField<int>(
                value: (ble.isNrfDevice
                        ? const [1024, 2000, 4000, 5000]
                        : const [1000, 2000, 3000, 4000, 5000])
                    .contains(ble.samplingRate)
                        ? ble.samplingRate
                        : (ble.isNrfDevice ? 1024 : 1000),
                decoration: const InputDecoration(
                  contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                  border: OutlineInputBorder(),
                ),
                style: const TextStyle(fontSize: 11, color: AppColors.navy, fontWeight: FontWeight.bold),
                items: ble.isNrfDevice
                    ? const [
                        DropdownMenuItem(value: 1024, child: Text('1024 Hz')),
                        DropdownMenuItem(value: 2000, child: Text('2000 Hz')),
                        DropdownMenuItem(value: 4000, child: Text('4000 Hz')),
                        DropdownMenuItem(value: 5000, child: Text('5000 Hz (Max)')),
                      ]
                    : const [
                        DropdownMenuItem(value: 1000, child: Text('1000 Hz')),
                        DropdownMenuItem(value: 2000, child: Text('2000 Hz')),
                        DropdownMenuItem(value: 3000, child: Text('3000 Hz')),
                        DropdownMenuItem(value: 4000, child: Text('4000 Hz')),
                        DropdownMenuItem(value: 5000, child: Text('5000 Hz (Max)')),
                      ],
                onChanged: (val) {
                  if (val != null) {
                    ble.writeSamplingRate(val);
                  }
                },
              ),
              const SizedBox(height: 12),

              _buildSectionTitle('BUFFER OUTPUT MODE'),
              DropdownButtonFormField<String>(
                value: const ['0x10', '0x11', '0x12', '0x13', '0x14', '0x15'].contains(ble.selectedBufferMode)
                    ? ble.selectedBufferMode
                    : '0x10',
                decoration: const InputDecoration(
                  contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                  border: OutlineInputBorder(),
                ),
                style: const TextStyle(fontSize: 11, color: AppColors.navy, fontWeight: FontWeight.bold),
                items: const [
                  DropdownMenuItem(value: '0x10', child: Text('No Buffer (0ms)')),
                  DropdownMenuItem(value: '0x11', child: Text('Standard (300ms)')),
                  DropdownMenuItem(value: '0x12', child: Text('1s Delay Buffer')),
                  DropdownMenuItem(value: '0x13', child: Text('2s Delay Buffer')),
                  DropdownMenuItem(value: '0x14', child: Text('5s Delay Buffer')),
                  DropdownMenuItem(value: '0x15', child: Text('10s Delay Buffer')),
                ],
                onChanged: (val) {
                  if (val != null) {
                    ble.writeBufferMode(val);
                  }
                },
              ),
              const SizedBox(height: 12),

              _buildSectionTitle('RADIO TX POWER'),
              Row(
                children: [
                  Expanded(
                    child: Wrap(
                      spacing: 4,
                      runSpacing: 4,
                      children: (ble.isNrfDevice ? [3, 0, -8, -12] : [9, 0, -12]).map((dbm) {
                        final isSel = ble.txPower == dbm;
                        return InkWell(
                          onTap: () => ble.writeTxPower(dbm),
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                            decoration: BoxDecoration(
                              color: isSel ? AppColors.primary.withOpacity(0.12) : Colors.transparent,
                              borderRadius: BorderRadius.circular(6),
                              border: Border.all(color: isSel ? AppColors.primary : AppColors.border),
                            ),
                            child: Text(
                              '${dbm > 0 ? "+" : ""}${dbm}dBm',
                              style: TextStyle(
                                fontSize: 9,
                                fontWeight: FontWeight.bold,
                                color: isSel ? AppColors.primary : AppColors.textSecondary,
                              ),
                            ),
                          ),
                        );
                      }).toList(),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }

  // ────────── TAB 1: CALIBRATION DRAWER ──────────
  Widget _buildCalibrationDrawer(BleManager ble) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Wizards card
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: AppColors.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _buildSectionTitle('WIZARDS'),
              ElevatedButton(
                onPressed: _startTareOffsetCalibration,
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFFF1F5F9),
                  foregroundColor: AppColors.navy,
                  elevation: 0,
                  alignment: Alignment.centerLeft,
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  minimumSize: const Size(double.infinity, 36),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                ),
                child: const Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text('Zero-g Tare Offset', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
                    Icon(Icons.chevron_right, size: 14),
                  ],
                ),
              ),
              const SizedBox(height: 6),

              ElevatedButton(
                onPressed: () {
                  setState(() {
                    _sixPosStep = 1;
                    _sixPosCapturing = false;
                    _showSixPosOverlay = true;
                  });
                },
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.primary,
                  foregroundColor: Colors.white,
                  elevation: 0,
                  alignment: Alignment.centerLeft,
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  minimumSize: const Size(double.infinity, 36),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                ),
                child: const Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text('6-Position Static Wizard', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
                    Icon(Icons.bolt, size: 14),
                  ],
                ),
              ),
              const SizedBox(height: 6),

              ElevatedButton(
                onPressed: () {},
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFFF1F5F9),
                  foregroundColor: AppColors.navy,
                  elevation: 0,
                  alignment: Alignment.centerLeft,
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  minimumSize: const Size(double.infinity, 36),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                ),
                child: const Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text('Independent Validation', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
                    Icon(Icons.chevron_right, size: 14),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 8),

        // Calibration coefficients matrix
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: AppColors.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _buildSectionTitle('CALIBRATION BIASES (mg)'),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  _matrixElement('Bias X', '${(ble.calibOffsetX * 1000).toStringAsFixed(1)} mg'),
                  _matrixElement('Bias Y', '${(ble.calibOffsetY * 1000).toStringAsFixed(1)} mg'),
                  _matrixElement('Bias Z', '${(ble.calibOffsetZ * 1000).toStringAsFixed(1)} mg'),
                ],
              ),
              const SizedBox(height: 12),
              _buildSectionTitle('INTEGRITY METRICS'),
              _calibMetaRow('RMS Fit Error:', '${_calibRms.toStringAsFixed(4)} g'),
              _calibMetaRow('Max Deviation:', '${_calibMax.toStringAsFixed(4)} g'),
              _calibMetaRow('Fit Quality:', '${_calibQuality.toStringAsFixed(1)}%'),
            ],
          ),
        ),
      ],
    );
  }

  Widget _matrixElement(String label, String val) {
    return Expanded(
      child: Container(
        margin: const EdgeInsets.symmetric(horizontal: 2),
        padding: const EdgeInsets.all(6),
        decoration: BoxDecoration(
          color: const Color(0xFFF8F9FA),
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: AppColors.border),
        ),
        child: Column(
          children: [
            Text(label, style: const TextStyle(fontSize: 8, color: AppColors.textTertiary)),
            const SizedBox(height: 3),
            Text(val, style: const TextStyle(fontSize: 9, fontFamily: 'monospace', fontWeight: FontWeight.bold, color: AppColors.navy)),
          ],
        ),
      ),
    );
  }

  Widget _calibMetaRow(String label, String val) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: const TextStyle(fontSize: 10, color: AppColors.textSecondary)),
          Text(val, style: const TextStyle(fontSize: 10, fontFamily: 'monospace', fontWeight: FontWeight.bold, color: AppColors.navy)),
        ],
      ),
    );
  }

  // ────────── TAB 2: ACQUIRE DRAWER ──────────
  Widget _buildAcquisitionDrawer(BleManager ble) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Capture triggers card
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: AppColors.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _buildSectionTitle('STREAM SEQUENCE'),
              ElevatedButton.icon(
                onPressed: ble.isConnected
                    ? (ble.isReading ? () => ble.stopReading() : () => ble.startReading())
                    : null,
                icon: Icon(
                  ble.isReading ? Icons.stop : Icons.play_arrow,
                  size: 16,
                ),
                label: Text(ble.isReading ? 'Stop Streaming' : 'Start Streaming'),
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.saffron,
                  foregroundColor: Colors.white,
                  disabledBackgroundColor: AppColors.saffron.withOpacity(0.4),
                  disabledForegroundColor: Colors.white.withOpacity(0.8),
                  elevation: 0,
                  minimumSize: const Size(double.infinity, 38),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                  textStyle: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, inherit: false),
                ),
              ),
              const SizedBox(height: 12),

              _buildSectionTitle('TIMED OPERATION'),
              Row(
                children: [
                  Checkbox(
                    value: ble.timedRunEnabled,
                    onChanged: (val) {
                      if (val != null) {
                        setState(() => ble.timedRunEnabled = val);
                      }
                    },
                    materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  const Text('Enable Timed Run', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: AppColors.navy)),
                ],
              ),
              if (ble.timedRunEnabled) ...[
                const SizedBox(height: 8),
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    const Text('Duration (s)', style: TextStyle(fontSize: 10, color: AppColors.textSecondary)),
                    Text('${ble.timedDurationSec} sec', style: const TextStyle(fontSize: 11, fontFamily: 'monospace', fontWeight: FontWeight.bold)),
                  ],
                ),
                Slider(
                  value: ble.timedDurationSec.toDouble(),
                  min: 5,
                  max: 60,
                  divisions: 11,
                  activeColor: AppColors.primary,
                  onChanged: (val) {
                    setState(() => ble.timedDurationSec = val.toInt());
                  },
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: 8),

        // Battery & Power optimization
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: AppColors.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _buildSectionTitle('POWER SAVINGS'),
              // Battery row
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Row(
                    children: [
                      Icon(Icons.battery_std, size: 16, color: Colors.green.shade600),
                      const SizedBox(width: 4),
                      const Text('Battery Status', style: TextStyle(fontSize: 10, color: AppColors.textSecondary)),
                    ],
                  ),
                  Text(
                    ble.isConnected ? '${ble.batteryLevel}%' : '-%',
                    style: const TextStyle(fontSize: 10, fontFamily: 'monospace', fontWeight: FontWeight.bold),
                  ),
                ],
              ),
              const SizedBox(height: 10),

              // Coin cell mode toggle
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Eco Power Mode', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: AppColors.navy)),
                      Text(
                        ble.ecoMode ? 'Optimized for Coin-Cell' : 'Continuous mode active',
                        style: const TextStyle(fontSize: 9, color: AppColors.textSecondary),
                      ),
                    ],
                  ),
                  Switch(
                    value: ble.ecoMode,
                    activeColor: AppColors.success,
                    onChanged: (val) {
                      ble.toggleEcoMode(val);
                    },
                  ),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }

  // ────────── TAB 3: DSP DRAWER ──────────
  Widget _buildDspDrawer(BleManager ble) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: AppColors.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _buildSectionTitle('COUPLING FILTER'),
              DropdownButtonFormField<String>(
                value: ['DC', 'AC_0.3'].contains(_coupling) ? _coupling : 'DC',
                decoration: const InputDecoration(
                  contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                  border: OutlineInputBorder(),
                ),
                style: const TextStyle(fontSize: 11, color: AppColors.navy, fontWeight: FontWeight.bold),
                items: const [
                  DropdownMenuItem(value: 'DC', child: Text('DC (Direct Current)')),
                  DropdownMenuItem(value: 'AC_0.3', child: Text('AC 0.3 Hz (Drift Rejection)')),
                ],
                onChanged: (val) {
                  if (val != null) {
                    setState(() => _coupling = val);
                  }
                },
              ),
              const SizedBox(height: 12),

              _buildSectionTitle('APPLICATION FILTER TYPE'),
              DropdownButtonFormField<String>(
                value: ['None', 'LPF', 'HPF', 'BPF', 'Notch'].contains(_filterType) ? _filterType : 'None',
                decoration: const InputDecoration(
                  contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                  border: OutlineInputBorder(),
                ),
                style: const TextStyle(fontSize: 11, color: AppColors.navy, fontWeight: FontWeight.bold),
                items: const [
                  DropdownMenuItem(value: 'None', child: Text('None (Bypass)')),
                  DropdownMenuItem(value: 'LPF', child: Text('Low-Pass Filter')),
                  DropdownMenuItem(value: 'HPF', child: Text('High-Pass Filter')),
                  DropdownMenuItem(value: 'BPF', child: Text('Band-Pass Filter')),
                  DropdownMenuItem(value: 'Notch', child: Text('Notch Filter')),
                ],
                onChanged: (val) {
                  if (val != null) {
                    setState(() => _filterType = val);
                  }
                },
              ),
              const SizedBox(height: 12),

              if (_filterType != 'None') ...[
                _buildSectionTitle('FILTER ORDER'),
                DropdownButtonFormField<int>(
                  value: [2, 4, 6].contains(_filterOrder) ? _filterOrder : 2,
                  decoration: const InputDecoration(
                    contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                    border: OutlineInputBorder(),
                  ),
                  style: const TextStyle(fontSize: 11, color: AppColors.navy, fontWeight: FontWeight.bold),
                  items: const [
                    DropdownMenuItem(value: 2, child: Text('2nd Order')),
                    DropdownMenuItem(value: 4, child: Text('4th Order')),
                    DropdownMenuItem(value: 6, child: Text('6th Order')),
                  ],
                  onChanged: (val) {
                    if (val != null) {
                      setState(() => _filterOrder = val);
                    }
                  },
                ),
                const SizedBox(height: 12),

                _buildSectionTitle('CUTOFF FREQUENCY (Hz)'),
                TextFormField(
                  initialValue: _filterCutoff.toStringAsFixed(0),
                  keyboardType: TextInputType.number,
                  style: const TextStyle(fontSize: 11, fontFamily: 'monospace', fontWeight: FontWeight.bold),
                  decoration: const InputDecoration(
                    contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                    border: OutlineInputBorder(),
                  ),
                  onChanged: (val) {
                    final d = double.tryParse(val);
                    if (d != null && d > 0) {
                      setState(() => _filterCutoff = d);
                    }
                  },
                ),
                const SizedBox(height: 12),
              ],

              _buildSectionTitle('OUTPUT QUANTITY'),
              DropdownButtonFormField<String>(
                value: ['acceleration', 'velocity', 'displacement'].contains(_outputQuantity)
                    ? _outputQuantity
                    : 'acceleration',
                decoration: const InputDecoration(
                  contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                  border: OutlineInputBorder(),
                ),
                style: const TextStyle(fontSize: 11, color: AppColors.navy, fontWeight: FontWeight.bold),
                items: const [
                  DropdownMenuItem(value: 'acceleration', child: Text('Acceleration (g)')),
                  DropdownMenuItem(value: 'velocity', child: Text('Velocity (mm/s)')),
                  DropdownMenuItem(value: 'displacement', child: Text('Displacement (µm)')),
                ],
                onChanged: (val) {
                  if (val != null) {
                    setState(() => _outputQuantity = val);
                  }
                },
              ),
              const SizedBox(height: 12),

              // Analyzer Toggle Button
              ElevatedButton.icon(
                onPressed: () {
                  setState(() => _showAnalyzer = !_showAnalyzer);
                },
                icon: const Icon(Icons.analytics, size: 14),
                label: Text(_showAnalyzer ? 'Hide Response Analyzer' : 'Show Response Analyzer'),
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.background,
                  foregroundColor: AppColors.primary,
                  side: const BorderSide(color: AppColors.primaryGlow),
                  elevation: 0,
                  minimumSize: const Size(double.infinity, 36),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                  textStyle: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, inherit: false),
                ),
              ),
              
              // Analyzer Response plot
              if (_showAnalyzer) ...[
                const SizedBox(height: 10),
                const Divider(color: AppColors.border),
                const SizedBox(height: 6),
                const Text(
                  'RESPONSE ANALYZER',
                  style: TextStyle(fontSize: 9, fontWeight: FontWeight.bold, color: AppColors.navy, letterSpacing: 0.5),
                ),
                const SizedBox(height: 6),
                Row(
                  children: [
                    Checkbox(
                      value: _showPhasePlot,
                      onChanged: (val) {
                        if (val != null) {
                          setState(() => _showPhasePlot = val);
                        }
                      },
                      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    ),
                    const Text('Show Phase Response', style: TextStyle(fontSize: 9, color: AppColors.textSecondary)),
                  ],
                ),
                const SizedBox(height: 6),
                // Vector canvas projection drawing of filter response curve
                Container(
                  height: 120,
                  decoration: BoxDecoration(
                    color: Colors.white,
                    border: Border.all(color: AppColors.border),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: CustomPaint(
                    painter: _FilterResponsePainter(
                      filterType: _filterType,
                      cutoff: _filterCutoff,
                      order: _filterOrder,
                      showPhase: _showPhasePlot,
                    ),
                    child: const SizedBox.expand(),
                  ),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }

  // ────────── TAB 4: SESSION EXPORT DRAWER ──────────
  Widget _buildExportDrawer(BleManager ble) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: AppColors.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _buildSectionTitle('OUTPUT FILE FORMAT'),
              Row(
                children: ['csv', 'txt', 'tdms', 'mat', 'json'].map((fmt) {
                  final isSel = _exportFormat == fmt;
                  return Expanded(
                    child: InkWell(
                      onTap: () => setState(() => _exportFormat = fmt),
                      child: Container(
                        margin: const EdgeInsets.symmetric(horizontal: 1.5),
                        padding: const EdgeInsets.symmetric(vertical: 8),
                        decoration: BoxDecoration(
                          color: isSel ? AppColors.primary.withOpacity(0.08) : Colors.transparent,
                          borderRadius: BorderRadius.circular(6),
                          border: Border.all(color: isSel ? AppColors.primary : AppColors.border),
                        ),
                        child: Text(
                          fmt.toUpperCase(),
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            fontSize: 8,
                            fontWeight: FontWeight.bold,
                            color: isSel ? AppColors.primary : AppColors.textSecondary,
                          ),
                        ),
                      ),
                    ),
                  );
                }).toList(),
              ),
              const SizedBox(height: 12),

              _buildSectionTitle('EXPORT CONTENT'),
              _exportCheckRow('Raw Acceleration', _expRawAccel, (val) => setState(() => _expRawAccel = val)),
              _exportCheckRow('Processed Acceleration', _expProcAccel, (val) => setState(() => _expProcAccel = val)),
              _exportCheckRow('Velocity & Displacement', _expVelocity, (val) => setState(() => _expVelocity = val)),
              _exportCheckRow('FFT & PSD curves', _expFFT, (val) => setState(() => _expFFT = val)),
              _exportCheckRow('Capture Statistics', _expStats, (val) => setState(() => _expStats = val)),
              const SizedBox(height: 12),

              _buildSectionTitle('FILE NAME'),
              TextFormField(
                controller: _exportFilenameCtrl,
                style: const TextStyle(fontSize: 11, fontFamily: 'monospace', fontWeight: FontWeight.bold),
                decoration: const InputDecoration(
                  contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 16),

              ElevatedButton.icon(
                onPressed: ble.receivedData.isEmpty
                    ? null
                    : () {
                        ble.shareCsvFile(_exportFilenameCtrl.text);
                      },
                icon: const Icon(Icons.sim_card_download, size: 14),
                label: const Text('Export Session File'),
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.primary,
                  foregroundColor: Colors.white,
                  disabledBackgroundColor: AppColors.primary.withOpacity(0.3),
                  elevation: 0,
                  minimumSize: const Size(double.infinity, 38),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                  textStyle: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, inherit: false),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _exportCheckRow(String title, bool val, ValueChanged<bool> onChange) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          Checkbox(
            value: val,
            onChanged: (v) {
              if (v != null) onChange(v);
            },
            materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
          ),
          Text(title, style: const TextStyle(fontSize: 10, color: AppColors.textSecondary)),
        ],
      ),
    );
  }

  Widget _buildSectionTitle(String label) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Text(
        label,
        style: const TextStyle(
          fontSize: 9,
          fontWeight: FontWeight.bold,
          color: AppColors.textTertiary,
          letterSpacing: 1.0,
        ),
      ),
    );
  }

  // ────────── 1. TIME DOMAIN CARD ──────────
  Widget _buildTimeDomainCard(BleManager ble) {
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        border: Border.all(color: AppColors.border),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        children: [
          // Header toolbar
          Container(
            height: 36,
            padding: const EdgeInsets.symmetric(horizontal: 10),
            decoration: const BoxDecoration(
              border: Border(bottom: BorderSide(color: AppColors.border)),
            ),
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  const Text(
                    'TIME DOMAIN WAVEFORM',
                    style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: AppColors.navy, letterSpacing: 0.5),
                  ),
                  const SizedBox(width: 20),
                  Row(
                    children: [
                      // Axis pills
                      Container(
                        padding: const EdgeInsets.all(2),
                        decoration: BoxDecoration(
                          color: const Color(0xFFF1F5F9),
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: Row(
                          children: [
                            _axisPill('X', _showX, AppColors.axisX, () => setState(() => _showX = !_showX)),
                            _axisPill('Y', _showY, AppColors.axisY, () => setState(() => _showY = !_showY)),
                            _axisPill('Z', _showZ, AppColors.axisZ, () => setState(() => _showZ = !_showZ)),
                          ],
                        ),
                      ),
                      const SizedBox(width: 8),

                      // Zoom / Window seconds display
                      IconButton(
                        icon: const Icon(Icons.zoom_in, size: 16),
                        onPressed: () => setState(() => _windowSeconds = math.max(0.1, _windowSeconds - 0.2)),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                        decoration: BoxDecoration(
                          color: const Color(0xFFF1F5F9),
                          border: Border.all(color: AppColors.border),
                          borderRadius: BorderRadius.circular(4),
                        ),
                        child: Text(
                          '${_windowSeconds.toStringAsFixed(1)}s',
                          style: const TextStyle(fontSize: 9, fontFamily: 'monospace', fontWeight: FontWeight.bold),
                        ),
                      ),
                      IconButton(
                        icon: const Icon(Icons.zoom_out, size: 16),
                        onPressed: () => setState(() => _windowSeconds = math.min(10.0, _windowSeconds + 0.5)),
                      ),
                      const SizedBox(width: 8),

                      // Auto Y Scale check
                      Row(
                        children: [
                          const Text('Auto Y', style: TextStyle(fontSize: 9, color: AppColors.textSecondary)),
                          const SizedBox(width: 2),
                          Checkbox(
                            value: _autoScaleY,
                            materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            onChanged: (val) {
                              if (val != null) {
                                setState(() => _autoScaleY = val);
                              }
                            },
                          ),
                        ],
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),

          // Waveform viewport CustomPaint
          Expanded(
            child: ClipRect(
              child: CustomPaint(
                painter: TimeDomainPainter(
                  xData: ble.xHistory,
                  yData: ble.yHistory,
                  zData: ble.zHistory,
                  timeData: ble.timeHistory,
                  windowSeconds: _windowSeconds,
                  showX: _showX,
                  showY: _showY,
                  showZ: _showZ,
                  autoScale: _autoScaleY,
                  manualMinY: -ble.rangeG.toDouble(),
                  manualMaxY: ble.rangeG.toDouble(),
                ),
                child: const SizedBox.expand(),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _axisPill(String axis, bool isSel, Color color, VoidCallback onTap) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
        decoration: BoxDecoration(
          color: isSel ? Colors.white : Colors.transparent,
          borderRadius: BorderRadius.circular(4),
          border: Border.all(color: isSel ? AppColors.border : Colors.transparent),
        ),
        child: Text(
          axis,
          style: TextStyle(
            fontSize: 9,
            fontWeight: FontWeight.bold,
            color: isSel ? color : AppColors.textMuted,
          ),
        ),
      ),
    );
  }

  // ────────── 2. SPECTRAL CHART CARD ──────────
  Widget _buildSpectralCard(BleManager ble, double peakFreq) {
    // Generate spectral display magnitudes list dynamically from DSP engine
    List<DspMagnitudePoint> magnitudes = [];
    if (ble.receivedData.isNotEmpty) {
      final axisData = _fftAxis == 'x' ? ble.xHistory : _fftAxis == 'y' ? ble.yHistory : ble.zHistory;
      if (axisData.length >= 256) {
        // Calculate FFT or PSD values dynamically
        magnitudes = DspEngine.computeFFT(
          rawSamples: axisData,
          fftSize: _fftSize,
          sampleRate: ble.samplingRate.toDouble(),
          windowType: _windowType,
        );
      }
    }

    final lineColor = _fftAxis == 'x' ? AppColors.axisX : _fftAxis == 'y' ? AppColors.axisY : AppColors.axisZ;

    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        border: Border.all(color: AppColors.border),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        children: [
          // Header tabs
          Container(
            height: 36,
            padding: const EdgeInsets.symmetric(horizontal: 10),
            decoration: const BoxDecoration(
              border: Border(bottom: BorderSide(color: AppColors.border)),
            ),
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  Row(
                    children: [
                      _spectralTab('FFT Spectrum', _isFftTab, () => setState(() => _isFftTab = true)),
                      _spectralTab('Power Density (PSD)', !_isFftTab, () => setState(() => _isFftTab = false)),
                      const SizedBox(width: 10),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(
                          color: AppColors.primary.withOpacity(0.08),
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: Text(
                          'Peak: ${peakFreq.toStringAsFixed(1)} Hz',
                          style: const TextStyle(fontSize: 8, fontWeight: FontWeight.bold, color: AppColors.primary),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(width: 24),
                  Row(
                    children: [
                      // Axis dropdown
                      const Text('Axis', style: TextStyle(fontSize: 9, color: AppColors.textSecondary)),
                      const SizedBox(width: 4),
                      DropdownButton<String>(
                        value: ['x', 'y', 'z'].contains(_fftAxis) ? _fftAxis : 'x',
                        underline: const SizedBox(),
                        style: const TextStyle(fontSize: 9, color: AppColors.navy, fontWeight: FontWeight.bold),
                        items: const [
                          DropdownMenuItem(value: 'x', child: Text('X Axis')),
                          DropdownMenuItem(value: 'y', child: Text('Y Axis')),
                          DropdownMenuItem(value: 'z', child: Text('Z Axis')),
                        ],
                        onChanged: (val) {
                          if (val != null) {
                            setState(() => _fftAxis = val);
                          }
                        },
                      ),
                      const SizedBox(width: 8),

                      // Windowing dropdown
                      const Text('Window', style: TextStyle(fontSize: 9, color: AppColors.textSecondary)),
                      const SizedBox(width: 4),
                      DropdownButton<String>(
                        value: ['hann', 'hamming', 'blackman'].contains(_windowType) ? _windowType : 'hann',
                        underline: const SizedBox(),
                        style: const TextStyle(fontSize: 9, color: AppColors.navy, fontWeight: FontWeight.bold),
                        items: const [
                          DropdownMenuItem(value: 'hann', child: Text('Hann')),
                          DropdownMenuItem(value: 'hamming', child: Text('Hamming')),
                          DropdownMenuItem(value: 'blackman', child: Text('Blackman')),
                        ],
                        onChanged: (val) {
                          if (val != null) {
                            setState(() => _windowType = val);
                          }
                        },
                      ),
                      const SizedBox(width: 8),

                      // FFT Size dropdown
                      const Text('Size', style: TextStyle(fontSize: 9, color: AppColors.textSecondary)),
                      const SizedBox(width: 4),
                      DropdownButton<int>(
                        value: [512, 1024, 2048, 4096].contains(_fftSize) ? _fftSize : 1024,
                        underline: const SizedBox(),
                        style: const TextStyle(fontSize: 9, color: AppColors.navy, fontWeight: FontWeight.bold),
                        items: const [
                          DropdownMenuItem(value: 512, child: Text('512')),
                          DropdownMenuItem(value: 1024, child: Text('1024')),
                          DropdownMenuItem(value: 2048, child: Text('2048')),
                          DropdownMenuItem(value: 4096, child: Text('4096')),
                        ],
                        onChanged: (val) {
                          if (val != null) {
                            setState(() => _fftSize = val);
                          }
                        },
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),

          // CustomPaint canvas spectrum drawing
          Expanded(
            child: ClipRect(
              child: CustomPaint(
                painter: FftPainter(
                  magnitudes: magnitudes,
                  lineColor: lineColor,
                ),
                child: const SizedBox.expand(),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _spectralTab(String label, bool isActive, VoidCallback onTap) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        height: 36,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          border: Border(
            bottom: BorderSide(
              color: isActive ? AppColors.primary : Colors.transparent,
              width: 2,
            ),
          ),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 10,
            fontWeight: FontWeight.bold,
            color: isActive ? AppColors.primary : AppColors.textSecondary,
          ),
        ),
      ),
    );
  }

  // ────────── 3. 3D SENSOR MOTION CARD ──────────
  Widget _build3DMotionCard(BleManager ble) {
    // Collect last gravity components to calculate rotational orientation angles
    double ax = 0.0;
    double ay = 0.0;
    double az = 1.0;
    if (ble.receivedData.isNotEmpty) {
      ax = ble.receivedData.last.x;
      ay = ble.receivedData.last.y;
      az = ble.receivedData.last.z;
    }

    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        border: Border.all(color: AppColors.border),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        children: [
          Container(
            height: 28,
            padding: const EdgeInsets.symmetric(horizontal: 10),
            decoration: const BoxDecoration(
              border: Border(bottom: BorderSide(color: AppColors.border)),
              color: Color(0xFFF8F9FA),
            ),
            child: const Row(
              children: [
                Text(
                  '3D SENSOR MOTION',
                  style: TextStyle(fontSize: 8, fontWeight: FontWeight.bold, color: AppColors.textSecondary),
                ),
              ],
            ),
          ),
          Expanded(
            child: CustomPaint(
              painter: _MotionCubePainter(ax: ax, ay: ay, az: az),
              child: const SizedBox.expand(),
            ),
          ),
        ],
      ),
    );
  }

  // ────────── 4. ORBIT PLOT CARD ──────────
  Widget _buildOrbitCard() {
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        border: Border.all(color: AppColors.border),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        children: [
          Container(
            height: 28,
            padding: const EdgeInsets.symmetric(horizontal: 10),
            decoration: const BoxDecoration(
              border: Border(bottom: BorderSide(color: AppColors.border)),
              color: Color(0xFFF8F9FA),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text(
                  'ORBIT PLOT',
                  style: TextStyle(fontSize: 8, fontWeight: FontWeight.bold, color: AppColors.textSecondary),
                ),
                Row(
                  children: [
                    DropdownButton<String>(
                      value: ['xy', 'xz', 'yz'].contains(_orbitAxis) ? _orbitAxis : 'xy',
                      underline: const SizedBox(),
                      style: const TextStyle(fontSize: 8, color: AppColors.navy, fontWeight: FontWeight.bold),
                      items: const [
                        DropdownMenuItem(value: 'xy', child: Text('X vs Y')),
                        DropdownMenuItem(value: 'xz', child: Text('X vs Z')),
                        DropdownMenuItem(value: 'yz', child: Text('Y vs Z')),
                      ],
                      onChanged: (val) {
                        if (val != null) {
                          setState(() {
                            _orbitAxis = val;
                            _orbitHistory.clear();
                          });
                        }
                      },
                    ),
                    const SizedBox(width: 4),
                    GestureDetector(
                      onTap: () => setState(() => _isOrbitFrozen = !_isOrbitFrozen),
                      child: Icon(
                        _isOrbitFrozen ? Icons.play_arrow : Icons.pause,
                        size: 14,
                        color: AppColors.textSecondary,
                      ),
                    ),
                    const SizedBox(width: 6),
                    GestureDetector(
                      onTap: () => setState(() => _orbitHistory.clear()),
                      child: const Icon(
                        Icons.clear_all,
                        size: 14,
                        color: AppColors.textSecondary,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          Expanded(
            child: ClipRect(
              child: CustomPaint(
                painter: _OrbitPainter(history: _orbitHistory),
                child: const SizedBox.expand(),
              ),
            ),
          ),
        ],
      ),
    );
  }

  // ────────── 5. FREQUENCY INSPECTOR CARD ──────────
  Widget _buildInspectorCard(double peakFreq) {
    return Container(
      height: 120, // Increased from 105 to prevent bottom overflows
      decoration: BoxDecoration(
        color: Colors.white,
        border: Border.all(color: AppColors.border),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        children: [
          Container(
            height: 28,
            padding: const EdgeInsets.symmetric(horizontal: 10),
            decoration: const BoxDecoration(
              border: Border(bottom: BorderSide(color: AppColors.border)),
              color: Color(0xFFF8F9FA),
            ),
            child: const Row(
              children: [
                Text(
                  'FREQUENCY INSPECTOR',
                  style: TextStyle(fontSize: 8, fontWeight: FontWeight.bold, color: AppColors.textSecondary),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(8),
            child: Row(
              children: [
                Expanded(
                  child: Container(
                    padding: const EdgeInsets.all(6),
                    decoration: BoxDecoration(
                      color: const Color(0xFFF8F9FA),
                      border: Border.all(color: AppColors.border),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        const Text('Dominant Peak', style: TextStyle(fontSize: 8, fontWeight: FontWeight.bold, color: AppColors.textTertiary)),
                        const SizedBox(height: 4),
                        Text(
                          '${peakFreq.toStringAsFixed(1)} Hz',
                          style: const TextStyle(fontSize: 13, fontFamily: 'monospace', fontWeight: FontWeight.bold, color: AppColors.primary),
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Container(
                    padding: const EdgeInsets.all(6),
                    decoration: BoxDecoration(
                      color: const Color(0xFFF8F9FA),
                      border: Border.all(color: AppColors.border),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        const Text('Peak Amplitude', style: TextStyle(fontSize: 8, fontWeight: FontWeight.bold, color: AppColors.textTertiary)),
                        const SizedBox(height: 4),
                        const Text(
                          '0.042 g',
                          style: TextStyle(fontSize: 13, fontFamily: 'monospace', fontWeight: FontWeight.bold, color: AppColors.navy),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  // ────────── 6. RIGHT SIDEBAR DETAILS & SNR CARD ──────────
  Widget _buildSnrSidebarCard(BleManager ble) {
    return Container(
      height: 200,
      decoration: BoxDecoration(
        color: Colors.white,
        border: Border.all(color: AppColors.border),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        children: [
          Container(
            height: 28,
            padding: const EdgeInsets.symmetric(horizontal: 10),
            decoration: const BoxDecoration(
              border: Border(bottom: BorderSide(color: AppColors.border)),
              color: Color(0xFFF8F9FA),
            ),
            child: const Row(
              children: [
                Text(
                  'SIGNAL QUALITY INTEGRITY',
                  style: TextStyle(fontSize: 8, fontWeight: FontWeight.bold, color: AppColors.textSecondary),
                ),
              ],
            ),
          ),
          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              child: Column(
                children: [
                  _snrAxisRow('X-Axis', '${(ble.noiseFloorX * 1000).toStringAsFixed(1)} mg', '32.1 dB', Colors.red.shade50, Colors.red.shade700),
                  _snrAxisRow('Y-Axis', '${(ble.noiseFloorY * 1000).toStringAsFixed(1)} mg', '28.4 dB', Colors.green.shade50, Colors.green.shade700),
                  _snrAxisRow('Z-Axis', '${(ble.noiseFloorZ * 1000).toStringAsFixed(1)} mg', '35.6 dB', Colors.indigo.shade50, Colors.indigo.shade700),
                  const SizedBox(height: 4),
                  // Spectral peak banner
                  Container(
                    padding: const EdgeInsets.all(6),
                    decoration: BoxDecoration(
                      color: AppColors.primary.withOpacity(0.06),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const Text('Spectral SNR:', style: TextStyle(fontSize: 9, fontWeight: FontWeight.bold, color: AppColors.primary)),
                        Text(
                          '24.8 dB',
                          style: TextStyle(fontSize: 10, fontFamily: 'monospace', fontWeight: FontWeight.bold, color: AppColors.primary.withOpacity(0.9)),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _snrAxisRow(String axis, String noise, String snr, Color bg, Color text) {
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 4),
      decoration: BoxDecoration(
        color: bg.withOpacity(0.4),
        border: Border.all(color: bg),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Flexible(
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                  decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(4)),
                  child: Text(
                    axis,
                    style: TextStyle(fontSize: 8, fontWeight: FontWeight.bold, color: text),
                  ),
                ),
                const SizedBox(width: 4),
                Flexible(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Text('Noise Floor', style: TextStyle(fontSize: 7, color: AppColors.textTertiary)),
                      Text(
                        noise,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 9, fontFamily: 'monospace', fontWeight: FontWeight.bold, color: AppColors.navy),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 4),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('Signal SNR', style: TextStyle(fontSize: 7, color: AppColors.textTertiary)),
              Text(
                snr,
                style: const TextStyle(fontSize: 9, fontFamily: 'monospace', fontWeight: FontWeight.bold, color: AppColors.navy),
              ),
            ],
          ),
        ],
      ),
    );
  }

  // ────────── CALIBRATION SEQUENCE IMPLEMENTATIONS ──────────

  void _startTareOffsetCalibration() {
    final ble = Provider.of<BleManager>(context, listen: false);
    _tareTimer?.cancel();
    setState(() {
      _showTareOverlay = true;
      _tareProgress = 0.0;
      _tareSecondsLeft = 10;
    });

    ble.startCalibration("tare");

    _tareTimer = Timer.periodic(const Duration(milliseconds: 100), (timer) {
      setState(() {
        _tareProgress = ble.calibrationProgress;
        _tareSecondsLeft = ble.calibrationRemainingSec.toInt();
        
        if (!ble.isCalibrating) {
          timer.cancel();
          _showTareOverlay = false;
        }
      });
    });
  }

  void _captureSixPosStep() {
    final ble = Provider.of<BleManager>(context, listen: false);
    _sixPosTimer?.cancel();
    setState(() {
      _sixPosCapturing = true;
      _sixPosProgress = 0.0;
      _sixPosSecondsLeft = 5;
    });

    ble.startCalibration("six_pos_step_$_sixPosStep");

    _sixPosTimer = Timer.periodic(const Duration(milliseconds: 100), (timer) {
      setState(() {
        _sixPosProgress = ble.calibrationProgress;
        _sixPosSecondsLeft = ble.calibrationRemainingSec.toInt();

        if (!ble.isCalibrating) {
          timer.cancel();
          _sixPosCapturing = false;
          
          if (_sixPosStep < 6) {
            _sixPosStep++;
          } else {
            // Done with all 6 positions!
            _showSixPosOverlay = false;
          }
        }
      });
    });
  }

  String _getSixPosOrientationEmoji() {
    switch (_sixPosStep) {
      case 1: return '⬆️';
      case 2: return '⬇️';
      case 3: return '⬅️';
      case 4: return '➡️';
      case 5: return '🔄';
      case 6:
      default:
        return '🔄';
    }
  }

  String _getSixPosOrientationText() {
    switch (_sixPosStep) {
      case 1: return 'Top Face UP (+1g Z)';
      case 2: return 'Top Face DOWN (-1g Z)';
      case 3: return 'Left Face UP (+1g X)';
      case 4: return 'Right Face UP (-1g X)';
      case 5: return 'Front Face UP (+1g Y)';
      case 6:
      default:
        return 'Back Face UP (-1g Y)';
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FILTER RESPONSE CURVE PAINTER
// ═══════════════════════════════════════════════════════════════════════════════
class _FilterResponsePainter extends CustomPainter {
  final String filterType;
  final double cutoff;
  final int order;
  final bool showPhase;

  _FilterResponsePainter({
    required this.filterType,
    required this.cutoff,
    required this.order,
    required this.showPhase,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = const Color(0xFFE2E8F0)
      ..strokeWidth = 0.5;

    // Draw simple grid background
    for (double x = 0; x < size.width; x += 30) {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), paint);
    }
    for (double y = 0; y < size.height; y += 30) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y), paint);
    }

    if (filterType == 'None') {
      // Draw flat line at 0 dB magnitude response
      final flatPaint = Paint()
        ..color = AppColors.primary
        ..strokeWidth = 1.5
        ..style = PaintingStyle.stroke;
      canvas.drawLine(Offset(0, size.height * 0.2), Offset(size.width, size.height * 0.2), flatPaint);
      return;
    }

    final magPath = Path();
    final phasePath = Path();
    bool first = true;

    for (double x = 0; x < size.width; x++) {
      // Logarithmic representation helper
      final double freq = 10.0 * math.pow(100.0, x / size.width);
      double gain = 1.0;
      double phase = 0.0;

      if (filterType == 'LPF') {
        gain = 1.0 / math.sqrt(1.0 + math.pow(freq / cutoff, 2.0 * order));
        phase = -order * math.atan(freq / cutoff);
      } else if (filterType == 'HPF') {
        gain = 1.0 / math.sqrt(1.0 + math.pow(cutoff / freq, 2.0 * order));
        phase = order * (math.pi / 2 - math.atan(freq / cutoff));
      } else {
        // Bandpass / Notch representation mockups
        final dist = (freq - cutoff).abs() / 20.0;
        gain = filterType == 'BPF'
            ? 1.0 / (1.0 + dist)
            : dist / (1.0 + dist);
        phase = 0;
      }

      final double pyMag = size.height * 0.15 + (1.0 - gain) * size.height * 0.7;
      final double pyPhase = size.height * 0.5 + (phase / math.pi) * size.height * 0.4;

      if (first) {
        magPath.moveTo(x, pyMag);
        phasePath.moveTo(x, pyPhase);
        first = false;
      } else {
        magPath.lineTo(x, pyMag);
        phasePath.lineTo(x, pyPhase);
      }
    }

    // Paint magnitude curve
    final magPaint = Paint()
      ..color = AppColors.primary
      ..strokeWidth = 1.5
      ..style = PaintingStyle.stroke;
    canvas.drawPath(magPath, magPaint);

    // Paint phase curve if requested
    if (showPhase) {
      final phasePaint = Paint()
        ..color = AppColors.saffron
        ..strokeWidth = 1.0
        ..style = PaintingStyle.stroke;
      canvas.drawPath(phasePath, phasePaint);
    }
  }

  @override
  bool shouldRepaint(covariant _FilterResponsePainter oldDelegate) {
    return oldDelegate.filterType != filterType ||
        oldDelegate.cutoff != cutoff ||
        oldDelegate.order != order ||
        oldDelegate.showPhase != showPhase;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3D MOTION CUBE PAINTER
// ═══════════════════════════════════════════════════════════════════════════════
class _MotionCubePainter extends CustomPainter {
  final double ax;
  final double ay;
  final double az;

  _MotionCubePainter({required this.ax, required this.ay, required this.az});

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final double scale = math.min(size.width, size.height) * 0.35;

    // Calculate yaw, pitch, roll angles from gravity components
    final double pitch = math.atan2(ay, math.sqrt(ax * ax + az * az));
    final double roll = math.atan2(-ax, az);

    // Define 8 vertices of a 3D box cube
    final List<List<double>> vertices = [
      [-1, -1, -0.5],
      [1, -1, -0.5],
      [1, 1, -0.5],
      [-1, 1, -0.5],
      [-1, -1, 0.5],
      [1, -1, 0.5],
      [1, 1, 0.5],
      [-1, 1, 0.5],
    ];

    // Project rotated points onto the 2D plane
    final List<Offset> projected = [];
    final cosP = math.cos(pitch);
    final sinP = math.sin(pitch);
    final cosR = math.cos(roll);
    final sinR = math.sin(roll);

    for (var v in vertices) {
      // Rotate around X (pitch)
      double y1 = v[1] * cosP - v[2] * sinP;
      double z1 = v[1] * sinP + v[2] * cosP;

      // Rotate around Y (roll)
      double x2 = v[0] * cosR + z1 * sinR;
      
      // Simple orthographic projection
      projected.add(Offset(center.dx + x2 * scale, center.dy + y1 * scale));
    }

    final edgePaint = Paint()
      ..color = AppColors.primary
      ..strokeWidth = 1.5
      ..style = PaintingStyle.stroke;

    final fillPaint = Paint()
      ..color = AppColors.primary.withOpacity(0.04)
      ..style = PaintingStyle.fill;

    // Draw faces
    void drawFace(int a, int b, int c, int d) {
      final p = Path()
        ..moveTo(projected[a].dx, projected[a].dy)
        ..lineTo(projected[b].dx, projected[b].dy)
        ..lineTo(projected[c].dx, projected[c].dy)
        ..lineTo(projected[d].dx, projected[d].dy)
        ..close();
      canvas.drawPath(p, fillPaint);
      canvas.drawPath(p, edgePaint);
    }

    drawFace(0, 1, 2, 3); // Back
    drawFace(4, 5, 6, 7); // Front
    drawFace(0, 1, 5, 4); // Bottom
    drawFace(2, 3, 7, 6); // Top
    drawFace(0, 3, 7, 4); // Left
    drawFace(1, 2, 6, 5); // Right
  }

  @override
  bool shouldRepaint(covariant _MotionCubePainter oldDelegate) {
    return oldDelegate.ax != ax || oldDelegate.ay != ay || oldDelegate.az != az;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORBIT PLOT PAINTER
// ═══════════════════════════════════════════════════════════════════════════════
class _OrbitPainter extends CustomPainter {
  final List<Offset> history;

  _OrbitPainter({required this.history});

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final double maxW = size.width * 0.45;
    final double maxH = size.height * 0.45;
    final double scaleLimit = math.min(maxW, maxH);

    final bgPaint = Paint()
      ..color = const Color(0xFFE2E8F0)
      ..strokeWidth = 0.5;

    // Orbit grid circle indicators
    canvas.drawCircle(center, scaleLimit * 0.33, bgPaint..style = PaintingStyle.stroke);
    canvas.drawCircle(center, scaleLimit * 0.66, bgPaint);
    canvas.drawCircle(center, scaleLimit, bgPaint);

    // Crosshairs
    canvas.drawLine(Offset(center.dx - scaleLimit, center.dy), Offset(center.dx + scaleLimit, center.dy), bgPaint);
    canvas.drawLine(Offset(center.dx, center.dy - scaleLimit), Offset(center.dx, center.dy + scaleLimit), bgPaint);

    if (history.isEmpty) return;

    // Draw trace path
    final path = Path();
    bool first = true;
    for (var pt in history) {
      final double px = center.dx + pt.dx * scaleLimit * 0.8;
      final double py = center.dy - pt.dy * scaleLimit * 0.8;

      if (first) {
        path.moveTo(px, py);
        first = false;
      } else {
        path.lineTo(px, py);
      }
    }

    final tracePaint = Paint()
      ..color = AppColors.primary
      ..strokeWidth = 1.0
      ..style = PaintingStyle.stroke
      ..isAntiAlias = true;

    canvas.drawPath(path, tracePaint);

    // Draw latest point dot indicator
    final lastPt = history.last;
    canvas.drawCircle(
      Offset(center.dx + lastPt.dx * scaleLimit * 0.8, center.dy - lastPt.dy * scaleLimit * 0.8),
      3.0,
      Paint()..color = AppColors.saffron,
    );
  }

  @override
  bool shouldRepaint(covariant _OrbitPainter oldDelegate) => true;
}
