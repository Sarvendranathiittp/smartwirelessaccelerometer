import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../ble_manager.dart';
import '../theme/app_theme.dart';
import '../widgets/widgets.dart';

class ScanScreen extends StatefulWidget {
  final VoidCallback onDeviceReady;

  const ScanScreen({super.key, required this.onDeviceReady});

  @override
  State<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends State<ScanScreen> {
  String _searchQuery = "";
  final TextEditingController _searchController = TextEditingController();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      Provider.of<BleManager>(context, listen: false).startScan();
    });
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ble = Provider.of<BleManager>(context);

    // Filter devices by search query
    final filteredResults = ble.scanResults.where((r) {
      final name = r.device.platformName.toLowerCase();
      final id = r.device.remoteId.str.toLowerCase();
      return name.contains(_searchQuery.toLowerCase()) || id.contains(_searchQuery.toLowerCase());
    }).toList();

    return Scaffold(
      backgroundColor: AppColors.background,
      resizeToAvoidBottomInset: false,
      body: Stack(
        children: [
          Column(
            children: [
              // ── 1. Top Header Bar ──────────────────────────────────────
              Container(
                height: 48,
                padding: const EdgeInsets.symmetric(horizontal: 12),
                decoration: const BoxDecoration(
                  color: Colors.white,
                  border: Border(bottom: BorderSide(color: AppColors.border)),
                ),
                child: SafeArea(
                  top: false,
                  bottom: false,
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
                                  // App Icon representation using our logo
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
                                  const Text(
                                    'Device Connection Management',
                                    style: TextStyle(
                                      fontSize: 14,
                                      fontWeight: FontWeight.bold,
                                      color: AppColors.navy,
                                    ),
                                  ),
                                ],
                              ),
                              Row(
                                children: [
                                  const Column(
                                    mainAxisAlignment: MainAxisAlignment.center,
                                    crossAxisAlignment: CrossAxisAlignment.end,
                                    children: [
                                      Text(
                                        'HOST BLUETOOTH',
                                        style: TextStyle(fontSize: 8, fontWeight: FontWeight.bold, color: AppColors.textSecondary, letterSpacing: 0.5),
                                      ),
                                      Text(
                                        'BLE 5.3, Enabled',
                                        style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: AppColors.primary, fontFamily: 'monospace'),
                                      ),
                                    ],
                                  ),
                                  const SizedBox(width: 8),
                                  const Icon(Icons.bluetooth, color: AppColors.primary, size: 20),
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

              // ── 2. Main Workspace ──────────────────────────────────────
              Expanded(
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    // Left Workspace: Scanned List
                    Expanded(
                      flex: 7,
                      child: Container(
                        color: AppColors.backgroundAlt,
                        child: SafeArea(
                          top: false,
                          bottom: false,
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                            // Toolbar controls
                            Padding(
                              padding: const EdgeInsets.all(12),
                              child: SingleChildScrollView(
                                scrollDirection: Axis.horizontal,
                                child: Row(
                                  children: [
                                    // Scan button
                                    ElevatedButton.icon(
                                      onPressed: ble.isScanning ? null : () => ble.startScan(),
                                      icon: Icon(
                                        ble.isScanning ? Icons.hourglass_empty : Icons.refresh,
                                        size: 14,
                                      ),
                                      label: Text(ble.isScanning ? 'Scanning...' : 'Scan Devices'),
                                      style: ElevatedButton.styleFrom(
                                        backgroundColor: AppColors.saffron,
                                        foregroundColor: Colors.white,
                                        elevation: 0,
                                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                                        textStyle: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, inherit: false),
                                      ),
                                    ),
                                    const SizedBox(width: 8),

                                    // Bypass button (For testing/dev)
                                    OutlinedButton.icon(
                                      onPressed: widget.onDeviceReady,
                                      icon: const Icon(Icons.developer_mode, size: 14),
                                      label: const Text('Bypass Connection'),
                                      style: OutlinedButton.styleFrom(
                                        foregroundColor: Colors.indigo.shade700,
                                        side: BorderSide(color: Colors.indigo.shade200),
                                        backgroundColor: Colors.indigo.shade50.withOpacity(0.5),
                                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                                        textStyle: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, inherit: false),
                                      ),
                                    ),
                                    const SizedBox(width: 12),

                                    // Search input field container with fixed size to support horizontal scrolling row
                                    Container(
                                      width: 200,
                                      height: 36,
                                      decoration: BoxDecoration(
                                        color: Colors.white,
                                        borderRadius: BorderRadius.circular(8),
                                        border: Border.all(color: AppColors.border),
                                        boxShadow: [
                                          BoxShadow(
                                            color: Colors.black.withOpacity(0.01),
                                            blurRadius: 3,
                                            offset: const Offset(0, 1),
                                          ),
                                        ],
                                      ),
                                      child: TextField(
                                        controller: _searchController,
                                        onChanged: (val) => setState(() => _searchQuery = val),
                                        style: const TextStyle(fontSize: 11, color: AppColors.navy),
                                        decoration: const InputDecoration(
                                          hintText: 'Search by Name, Sensor, Firmware...',
                                          hintStyle: TextStyle(fontSize: 11, color: AppColors.textMuted),
                                          prefixIcon: Icon(Icons.search, size: 16, color: AppColors.textMuted),
                                          border: InputBorder.none,
                                          contentPadding: EdgeInsets.symmetric(vertical: 10),
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ),

                            // List area
                            Expanded(
                              child: filteredResults.isEmpty
                                  ? Center(
                                      child: Column(
                                        mainAxisSize: MainAxisSize.min,
                                        children: [
                                          Icon(Icons.sensors_off, size: 36, color: AppColors.textMuted.withOpacity(0.7)),
                                          const SizedBox(height: 8),
                                          const Text(
                                            'No Instruments Detected',
                                            style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppColors.textSecondary),
                                          ),
                                          const SizedBox(height: 4),
                                          Text(
                                            ble.isScanning
                                                ? 'Scanning for accelerometer nodes...'
                                                : 'Click "Scan Devices" above to discover nearby nodes.',
                                            style: const TextStyle(fontSize: 10, color: AppColors.textMuted),
                                          ),
                                        ],
                                      ),
                                    )
                                  : ListView.builder(
                                      padding: const EdgeInsets.symmetric(horizontal: 12),
                                      itemCount: filteredResults.length,
                                      itemBuilder: (context, idx) {
                                        final result = filteredResults[idx];
                                        final devName = result.device.platformName.isNotEmpty
                                            ? result.device.platformName
                                            : 'ISRO_AccelSensor';
                                        final isMatch = devName.contains('ISRO') || devName.contains('Accel');

                                        final isSelected = ble.connectedDevice != null &&
                                            ble.connectedDevice!.remoteId == result.device.remoteId;

                                        return Container(
                                          margin: const EdgeInsets.only(bottom: 8),
                                          decoration: BoxDecoration(
                                            color: Colors.white,
                                            borderRadius: BorderRadius.circular(10),
                                            border: Border.all(
                                              color: isSelected
                                                  ? AppColors.primary
                                                  : isMatch
                                                      ? AppColors.primary.withOpacity(0.3)
                                                      : AppColors.border,
                                              width: isSelected || isMatch ? 1.5 : 1,
                                            ),
                                            boxShadow: [
                                              BoxShadow(
                                                color: Colors.black.withOpacity(0.01),
                                                blurRadius: 3,
                                                offset: const Offset(0, 1),
                                              ),
                                            ],
                                          ),
                                          child: ListTile(
                                            dense: true,
                                            leading: Container(
                                              width: 32,
                                              height: 32,
                                              decoration: BoxDecoration(
                                                color: isMatch ? AppColors.primary.withOpacity(0.08) : const Color(0xFFF1F5F9),
                                                borderRadius: BorderRadius.circular(6),
                                              ),
                                              child: Icon(
                                                isMatch ? Icons.sensors : Icons.bluetooth,
                                                size: 16,
                                                color: isMatch ? AppColors.primary : AppColors.textSecondary,
                                              ),
                                            ),
                                            title: Text(
                                              devName,
                                              style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppColors.navy),
                                            ),
                                            subtitle: Row(
                                              children: [
                                                Text(
                                                  result.device.remoteId.str,
                                                  style: const TextStyle(fontSize: 9, fontFamily: 'monospace', color: AppColors.textSecondary),
                                                ),
                                                const SizedBox(width: 8),
                                                Text(
                                                  '${result.rssi} dBm',
                                                  style: const TextStyle(fontSize: 9, fontFamily: 'monospace', color: AppColors.textSecondary),
                                                ),
                                              ],
                                            ),
                                            trailing: SizedBox(
                                              height: 26,
                                              child: ElevatedButton(
                                                onPressed: () => ble.connectToDevice(result.device),
                                                style: ElevatedButton.styleFrom(
                                                  backgroundColor: isSelected ? AppColors.success : AppColors.primary,
                                                  foregroundColor: Colors.white,
                                                  elevation: 0,
                                                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 0),
                                                  minimumSize: const Size(60, 24),
                                                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                                                ),
                                                child: Text(
                                                  isSelected ? 'CONNECTED' : 'CONNECT',
                                                  style: const TextStyle(fontSize: 9, fontWeight: FontWeight.bold),
                                                ),
                                              ),
                                            ),
                                          ),
                                        );
                                      },
                                    ),
                            ),
                          ],
                          ),
                        ),
                      ),
                    ),

                    // Right Sidebar: Node Details panel
                    if (ble.connectedDevice != null)
                      Container(
                        width: 240,
                        decoration: const BoxDecoration(
                          color: Colors.white,
                          border: Border(left: BorderSide(color: AppColors.border)),
                        ),
                        child: SafeArea(
                        top: false,
                        bottom: false,
                        child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          // Details header
                          Padding(
                            padding: const EdgeInsets.all(12),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                const Text(
                                  'Node Details',
                                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: AppColors.navy),
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  ble.isConnected && ble.connectedDevice != null
                                      ? 'MAC: ${ble.connectedDevice!.remoteId.str}'
                                      : 'MAC: --:--:--:--:--:--',
                                  style: const TextStyle(fontSize: 9, fontFamily: 'monospace', color: AppColors.textSecondary),
                                ),
                              ],
                            ),
                          ),
                          const Divider(height: 1, color: AppColors.border),

                          // Details entries
                          Expanded(
                            child: SingleChildScrollView(
                              padding: const EdgeInsets.all(12),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.stretch,
                                children: [
                                  Row(
                                    children: [
                                      Icon(Icons.info_outline, color: AppColors.primary, size: 16),
                                      const SizedBox(width: 6),
                                      const Text(
                                        'General Details',
                                        style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: AppColors.primary),
                                      ),
                                    ],
                                  ),
                                  const SizedBox(height: 10),

                                  _detailRow('Status', ble.isConnected ? 'CONNECTED' : 'DISCONNECTED',
                                      valueColor: ble.isConnected ? AppColors.success : AppColors.textMuted),
                                  _detailRow('Transducer', ble.isConnected ? ble.sensorName : '-'),
                                  _detailRow('Dynamic Range', ble.isConnected ? '±${ble.rangeG}g' : '-'),
                                  _detailRow('Sampling Rate', ble.isConnected ? '${ble.samplingRate} Hz' : '-'),
                                  _detailRow('TX Power', ble.isConnected ? '${ble.txPower} dBm' : '-'),
                                  
                                  // Battery Row with Green battery icon
                                  Padding(
                                    padding: const EdgeInsets.symmetric(vertical: 4),
                                    child: Row(
                                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                      children: [
                                        const Text('Battery Level', style: TextStyle(fontSize: 10, color: AppColors.textSecondary)),
                                        Row(
                                          mainAxisSize: MainAxisSize.min,
                                          children: [
                                            Text(
                                              ble.isConnected ? '${ble.batteryLevel}%' : '-%',
                                              style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, fontFamily: 'monospace', color: AppColors.navy),
                                            ),
                                            const SizedBox(width: 4),
                                            Icon(
                                              Icons.battery_std,
                                              size: 14,
                                              color: ble.isConnected && ble.batteryLevel > 20
                                                  ? AppColors.success
                                                  : AppColors.error,
                                            ),
                                          ],
                                        ),
                                      ],
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ),

                          // CTA action at bottom
                          Padding(
                            padding: const EdgeInsets.all(12),
                            child: ElevatedButton(
                              onPressed: ble.isConnected ? widget.onDeviceReady : null,
                              style: ElevatedButton.styleFrom(
                                backgroundColor: AppColors.saffron,
                                foregroundColor: Colors.white,
                                disabledBackgroundColor: AppColors.saffron.withOpacity(0.4),
                                disabledForegroundColor: Colors.white.withOpacity(0.8),
                                elevation: 0,
                                minimumSize: const Size(double.infinity, 38),
                                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                              ),
                              child: const Text('Start Acquisition', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),

          // ── 3. Bottom Status Bar ───────────────────────────────────
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
                                  color: ble.isConnected ? AppColors.success : AppColors.textMuted,
                                  shape: BoxShape.circle,
                                ),
                              ),
                              const SizedBox(width: 6),
                              Text(
                                ble.isConnected ? 'Ready' : 'Disconnected',
                                style: const TextStyle(fontSize: 8, fontWeight: FontWeight.bold, color: AppColors.textSecondary, letterSpacing: 0.5),
                              ),
                              const SizedBox(width: 16),
                              Icon(Icons.sensors, size: 10, color: ble.isScanning ? AppColors.primary : AppColors.textSecondary),
                              const SizedBox(width: 4),
                              Text(
                                ble.isScanning ? 'Discovery Scanning...' : 'Discovery Idle',
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

          // Connecting overlay
          if (ble.isConnecting)
            Container(
              color: Colors.black38,
              child: Center(
                child: Container(
                  width: 280,
                  padding: const EdgeInsets.all(20),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(12),
                    boxShadow: [
                      BoxShadow(
                        color: Colors.black.withOpacity(0.1),
                        blurRadius: 10,
                      ),
                    ],
                  ),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const SizedBox(
                        width: 28,
                        height: 28,
                        child: CircularProgressIndicator(strokeWidth: 3, color: AppColors.primary),
                      ),
                      const SizedBox(height: 16),
                      const Text(
                        'Connecting Accelerometer',
                        style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppColors.navy),
                      ),
                      const SizedBox(height: 4),
                      const Text(
                        'ESTABLISHING GATT LINK...',
                        style: TextStyle(fontSize: 9, fontFamily: 'monospace', color: AppColors.primary, fontWeight: FontWeight.bold),
                      ),
                      const SizedBox(height: 16),
                      OutlinedButton(
                        onPressed: () => ble.disconnect(),
                        style: OutlinedButton.styleFrom(
                          foregroundColor: Colors.red,
                          side: const BorderSide(color: Colors.red),
                          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                        ),
                        child: const Text('ABORT SEQUENCE', style: TextStyle(fontSize: 9, fontWeight: FontWeight.bold)),
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

  Widget _detailRow(String label, String value, {Color? valueColor}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: const TextStyle(fontSize: 10, color: AppColors.textSecondary)),
          const SizedBox(width: 8),
          Flexible(
            child: Text(
              value,
              textAlign: TextAlign.end,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 10,
                fontWeight: FontWeight.bold,
                fontFamily: 'monospace',
                color: valueColor ?? AppColors.navy,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
