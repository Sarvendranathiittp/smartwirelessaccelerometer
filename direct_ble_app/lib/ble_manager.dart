import 'dart:async';
import 'dart:math' as math;
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter/foundation.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:path_provider/path_provider.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:share_plus/share_plus.dart';
import 'dsp_engine.dart';

// Acceleration point structure
class AccelDataPoint {
  final double timeSec;
  final int rawTimestamp;
  final double x;
  final double y;
  final double z;

  AccelDataPoint({
    required this.timeSec,
    required this.rawTimestamp,
    required this.x,
    required this.y,
    required this.z,
  });

  Map<String, dynamic> toJson() => {
    't': timeSec,
    'ts': rawTimestamp,
    'x': x,
    'y': y,
    'z': z,
  };
}

class BleManager extends ChangeNotifier {
  static const String serviceUuid = "12340000-1234-5678-9abc-def012345678";
  static const String dataCharUuid = "12340001-1234-5678-9abc-def012345678";
  static const String sampleRateCharUuid = "12340003-1234-5678-9abc-def012345678";
  static const String sensorMetaCharUuid = "12340004-1234-5678-9abc-def012345678";
  static const String modeCharUuid = "12340005-1234-5678-9abc-def012345678";
  static const String txPowerCharUuid = "12340006-1234-5678-9abc-def012345678";
  static const String batteryCharUuid = "12340007-1234-5678-9abc-def012345678";

  BluetoothDevice? connectedDevice;
  BluetoothCharacteristic? dataCharacteristic;
  BluetoothCharacteristic? modeCharacteristic;
  BluetoothCharacteristic? sampleRateCharacteristic;
  BluetoothCharacteristic? sensorMetaCharacteristic;
  BluetoothCharacteristic? txPowerCharacteristic;
  BluetoothCharacteristic? batteryCharacteristic;

  bool isScanning = false;
  bool isConnected = false;
  bool isConnecting = false;
  bool isReading = false;
  bool shouldAutoReconnect = false;
  bool isReconnecting = false;

  // Active configurations matching the hardware GATT state
  int samplingRate = 1024;
  int txPower = 0;
  int batteryLevel = 0;
  String sensorName = "ADXL345";
  int rangeG = 2;
  double lsbPerG = 256.0;
  bool h3lisAvailable = false;
  bool mpuAvailable = false;
  bool isNrfDevice = false;
  bool ecoMode = false;
  String activeSensor = "ADXL345";

  // RX raw bytes buffer to reassemble fragmented BLE packets
  final List<int> _rxBuffer = [];
  int _expectedPacketSize = 239; // Default to 239 bytes for Rev 9 telemetry format

  // Active session data
  List<AccelDataPoint> receivedData = [];
  int sampleCount = 0;
  int droppedSamples = 0;
  
  // Rolling queues for UI charts (limits size to prevent memory leaks)
  List<double> xHistory = [];
  List<double> yHistory = [];
  List<double> zHistory = [];
  List<double> timeHistory = [];
  
  // Latency Metrics
  List<double> latencyHistory = [];
  double latencyCurrent = 0.0;
  double latencyAvg = 0.0;
  double latencyMax = 0.0;

  // Clock sync offsets for E2E latency
  int? _latencySyncBrowserTs;
  int? _latencySyncFwTs;

  // Timestamp unwrapping variables
  int _lastFwTs = 0;
  int _fwTsWrapOffset = 0;
  int _lastSampleCounter = 0;

  // Calibration Offsets (Zero-g Tare)
  double calibOffsetX = 0.0;
  double calibOffsetY = 0.0;
  double calibOffsetZ = 0.0;

  // Calibration Noise Baseline (Standard Deviation)
  double noiseFloorX = 0.0563; // 56.3 mg default
  double noiseFloorY = 0.0563;
  double noiseFloorZ = 0.0563;

  // Calibration State
  bool isCalibrating = false;
  String calibrationType = "noise"; // "noise" or "tare"
  List<List<double>> calibrationSamples = []; // [[x,y,z], ...]
  double calibrationProgress = 0.0;
  double calibrationRemainingSec = 10.0;

  // Timed Run State
  bool timedRunEnabled = false;
  int timedDurationSec = 10;
  Timer? _timedRunTimer;
  double timedRunRemainingSec = 0.0;

  // Selected buffer latency mode
  String selectedBufferMode = "0x11"; // Default to standard buffer

  // Scan subscription
  StreamSubscription<List<ScanResult>>? _scanSubscription;
  StreamSubscription<BluetoothConnectionState>? _connSubscription;
  StreamSubscription<List<int>>? _dataSubscription;
  StreamSubscription<List<int>>? _batterySubscription;

  BleManager() {
    _loadCalibrationData();
    
    // Monitor Bluetooth state
    FlutterBluePlus.adapterState.listen((state) {
      if (state != BluetoothAdapterState.on) {
        _handleDisconnect();
      }
    });

    // Monitor scanning status
    FlutterBluePlus.isScanning.listen((scanning) {
      isScanning = scanning;
      notifyListeners();
    });

    // Accumulate scan results globally (filtered to ISRO/Accel devices only)
    FlutterBluePlus.scanResults.listen((results) {
      scanResults = results.where((r) => 
        r.device.platformName.isNotEmpty &&
        (r.device.platformName.contains("ISRO") || r.device.platformName.contains("Accel"))
      ).toList();
      notifyListeners();
    });
  }

  // Request required Android BLE and Location permissions
  Future<bool> requestPermissions() async {
    if (Platform.isAndroid) {
      Map<Permission, PermissionStatus> statuses = await [
        Permission.bluetoothScan,
        Permission.bluetoothConnect,
        Permission.bluetoothAdvertise,
        Permission.location,
      ].request();
      
      final scanGranted = statuses[Permission.bluetoothScan]?.isGranted ?? false;
      final connectGranted = statuses[Permission.bluetoothConnect]?.isGranted ?? false;
      final locationGranted = statuses[Permission.location]?.isGranted ?? false;

      // Scan/connect are required for Android 12+, location is required for older devices
      if (scanGranted && connectGranted) {
        return true;
      }
      return locationGranted;
    }
    return true;
  }

  List<ScanResult> scanResults = [];

  // Start BLE discovery scan
  Future<void> startScan() async {
    if (isConnected || isConnecting) return;

    final permissionsGranted = await requestPermissions();
    if (!permissionsGranted) {
      throw Exception("Required Bluetooth/Location permissions were denied.");
    }

    // Automatically prompt user to turn on Bluetooth if disabled
    try {
      if (await FlutterBluePlus.adapterState.first != BluetoothAdapterState.on) {
        await FlutterBluePlus.turnOn();
      }
    } catch (e) {
      debugPrint("Failed to turn on Bluetooth: $e");
    }

    scanResults.clear();
    notifyListeners();

    try {
      await FlutterBluePlus.startScan(
        timeout: const Duration(seconds: 15),
      );
    } catch (e) {
      rethrow;
    }
  }

  // Connect to a specific scanned device
  Future<void> connectToDevice(BluetoothDevice device) async {
    if (isConnected || isConnecting) return;

    isConnecting = true;
    shouldAutoReconnect = true;
    notifyListeners();

    try {
      await FlutterBluePlus.stopScan();
      isScanning = false;
      notifyListeners();
      await _connectToDevice(device);
    } catch (e) {
      isConnecting = false;
      shouldAutoReconnect = false;
      notifyListeners();
      rethrow;
    }
  }

  // Legacy connect triggers startScan
  Future<void> connect() async {
    await startScan();
  }

  Future<void> _connectToDevice(BluetoothDevice device) async {
    try {
      connectedDevice = device;
      
      // Listen to connection state
      _connSubscription?.cancel();
      _connSubscription = device.connectionState.listen((state) {
        if (state == BluetoothConnectionState.connected) {
          isConnected = true;
          isConnecting = false;
          isReconnecting = false;
          notifyListeners();
        } else if (state == BluetoothConnectionState.disconnected) {
          _handleDisconnect();
        }
      });

      await device.connect(autoConnect: false, license: License.nonprofit);

      // Request MTU 247 on Android for packet fragment prevention
      if (Platform.isAndroid) {
        try {
          await device.requestMtu(247);
          debugPrint("Requested MTU 247 successfully");
        } catch (e) {
          debugPrint("Failed to request MTU: $e");
        }
        // Short delay to let GATT stable
        await Future.delayed(const Duration(milliseconds: 500));
      }
      
      // Discover services
      List<BluetoothService> services = await device.discoverServices();
      for (BluetoothService service in services) {
        if (service.uuid == Guid(serviceUuid)) {
          for (BluetoothCharacteristic characteristic in service.characteristics) {
            if (characteristic.uuid == Guid(dataCharUuid)) {
              dataCharacteristic = characteristic;
            } else if (characteristic.uuid == Guid(modeCharUuid)) {
              modeCharacteristic = characteristic;
            } else if (characteristic.uuid == Guid(sampleRateCharUuid)) {
              sampleRateCharacteristic = characteristic;
            } else if (characteristic.uuid == Guid(sensorMetaCharUuid)) {
              sensorMetaCharacteristic = characteristic;
            } else if (characteristic.uuid == Guid(txPowerCharUuid)) {
              txPowerCharacteristic = characteristic;
            } else if (characteristic.uuid == Guid(batteryCharUuid)) {
              batteryCharacteristic = characteristic;
            }
          }
        }
      }

      if (dataCharacteristic == null) {
        throw Exception("Required GATT characteristics not found on sensor.");
      }

      // Read initial values for sensor parameters if available
      try {
        if (sensorMetaCharacteristic != null) {
          final val = await sensorMetaCharacteristic!.read();
          if (val.isNotEmpty) {
            // Decode sensor name (first 24 bytes)
            final nameBytes = val.sublist(0, math.min(24, val.length));
            sensorName = utf8.decode(nameBytes).replaceAll(RegExp(r'\x00'), '').trim();
            if (sensorName.isEmpty) {
              sensorName = "ADXL345";
            }
            
            // Read rangeG (offset 24, size 2)
            if (val.length >= 26) {
              final byteData = ByteData.sublistView(Uint8List.fromList(val));
              rangeG = byteData.getInt16(24, Endian.little);
            }
            
            // Read statuses (offset 34, 35)
            if (val.length >= 36) {
              h3lisAvailable = val[34] == 1;
              mpuAvailable = val[35] == 1;
            }
            
            // Update active sensor and scale
            activeSensor = sensorName.contains("H3LIS") ? "H3LIS331DL" : "ADXL345";
            _updateLSBPerG(rangeG);
          }
        }
      } catch (e) {
        debugPrint("Could not read initial metadata: $e");
      }

      try {
        if (sampleRateCharacteristic != null) {
          final val = await sampleRateCharacteristic!.read();
          if (val.length >= 2) {
            final byteData = ByteData.sublistView(Uint8List.fromList(val));
            samplingRate = byteData.getUint16(0, Endian.little);
          }
        }
      } catch (e) {
        debugPrint("Could not read initial sampling rate: $e");
      }

      try {
        if (txPowerCharacteristic != null) {
          final val = await txPowerCharacteristic!.read();
          if (val.isNotEmpty) {
            final byteData = ByteData.sublistView(Uint8List.fromList(val));
            txPower = byteData.getInt8(0);
            
            // Auto detect nRF based on typical values
            final nrfSpecificValues = [-8, -40, 3, -1, -2, -3, -4, -5, -6, -7, -16, -20];
            if (nrfSpecificValues.contains(txPower)) {
              isNrfDevice = true;
            }
          }
        }
      } catch (e) {
        debugPrint("Could not read initial TX power: $e");
      }

      // Check nRF state from device name fallback
      final devName = device.platformName;
      if (devName.toUpperCase().contains("NRF") || devName.toUpperCase().contains("ISRO")) {
        isNrfDevice = true;
      }

      // Read battery level and subscribe to changes
      try {
        if (batteryCharacteristic != null) {
          final val = await batteryCharacteristic!.read();
          if (val.isNotEmpty) {
            batteryLevel = val[0];
          }
          
          await batteryCharacteristic!.setNotifyValue(true);
          _batterySubscription?.cancel();
          _batterySubscription = batteryCharacteristic!.onValueReceived.listen((bytes) {
            if (bytes.isNotEmpty) {
              batteryLevel = bytes[0];
              notifyListeners();
            }
          });
        }
      } catch (e) {
        debugPrint("Could not read or subscribe to battery: $e");
      }

      // Ensure streaming is stopped initially by writing 0 to the CCCD descriptor directly
      try {
        for (BluetoothDescriptor d in dataCharacteristic!.descriptors) {
          if (d.uuid == Guid("00002902-0000-1000-8000-00805f9b34fb")) {
            await d.write([0, 0]);
            debugPrint("Forced CCCD write 0x0000 success");
          }
        }
        await dataCharacteristic!.setNotifyValue(false);
      } catch (e) {
        debugPrint("Error disabling notifications on init: $e");
      }

      isConnected = true;
      isConnecting = false;
      notifyListeners();

    } catch (e) {
      _handleDisconnect();
      rethrow;
    }
  }

  void _handleDisconnect() {
    final bool wasReading = isReading;

    isConnected = false;
    isConnecting = false;
    isReading = false;
    _dataSubscription?.cancel();
    _timedRunTimer?.cancel();
    _timedRunTimer = null;
    isCalibrating = false;

    notifyListeners();

    if (shouldAutoReconnect && connectedDevice != null) {
      _attemptAutoReconnect(wasReading: wasReading);
    }
  }

  Future<void> _attemptAutoReconnect({bool wasReading = false}) async {
    if (isReconnecting || !shouldAutoReconnect || connectedDevice == null) return;
    isReconnecting = true;
    notifyListeners();

    while (shouldAutoReconnect && !isConnected) {
      try {
        await connectedDevice!.connect(
          autoConnect: false,
          timeout: const Duration(seconds: 5),
          license: License.nonprofit,
        );
        
        // Re-discover characteristics
        List<BluetoothService> services = await connectedDevice!.discoverServices();
        for (BluetoothService service in services) {
          if (service.uuid == Guid(serviceUuid)) {
            for (BluetoothCharacteristic char in service.characteristics) {
              if (char.uuid == Guid(dataCharUuid)) dataCharacteristic = char;
              if (char.uuid == Guid(modeCharUuid)) modeCharacteristic = char;
            }
          }
        }
        
        isReconnecting = false;
        if (wasReading) {
          await startReading(isReconnect: true);
        } else {
          // Explicitly clear CCCD of data characteristic on silent reconnection
          try {
            for (BluetoothDescriptor d in dataCharacteristic!.descriptors) {
              if (d.uuid == Guid("00002902-0000-1000-8000-00805f9b34fb")) {
                await d.write([0, 0]);
              }
            }
            await dataCharacteristic!.setNotifyValue(false);
          } catch (_) {}
        }
        break;
      } catch (e) {
        // Retry connection loop
        await Future.delayed(const Duration(milliseconds: 1000));
      }
    }
    isReconnecting = false;
    notifyListeners();
  }

  Future<void> disconnect() async {
    shouldAutoReconnect = false;
    _scanSubscription?.cancel();
    _connSubscription?.cancel();
    _dataSubscription?.cancel();
    
    if (connectedDevice != null) {
      await connectedDevice!.disconnect();
    }
    
    connectedDevice = null;
    dataCharacteristic = null;
    modeCharacteristic = null;
    isConnected = false;
    isConnecting = false;
    isReading = false;
    _timedRunTimer?.cancel();
    _timedRunTimer = null;
    isCalibrating = false;
    
    notifyListeners();
  }

  // Write buffer/latency config byte to Operating Mode Characteristic
  Future<void> writeBufferMode(String hexValue) async {
    if (modeCharacteristic == null) return;
    try {
      final valueByte = int.parse(hexValue.replaceFirst("0x", ""), radix: 16);
      await modeCharacteristic!.write([valueByte], withoutResponse: false);
      selectedBufferMode = hexValue;
      notifyListeners();
    } catch (e) {
      debugPrint("Error writing buffer mode: $e");
    }
  }

  // Start active notifications
  Future<void> startReading({bool isReconnect = false}) async {
    if (dataCharacteristic == null) return;

    if (!isReconnect) {
      // Clear session data
      receivedData.clear();
      xHistory.clear();
      yHistory.clear();
      zHistory.clear();
      timeHistory.clear();
      sampleCount = 0;
      droppedSamples = 0;
      latencyHistory.clear();
      latencyCurrent = 0.0;
      latencyAvg = 0.0;
      latencyMax = 0.0;
      _latencySyncBrowserTs = null;
      _latencySyncFwTs = null;
      _lastFwTs = 0;
      _fwTsWrapOffset = 0;
      _lastSampleCounter = 0;
    } else {
      // Reset packet tracking for the new connection burst
      _lastSampleCounter = 0;
      _lastFwTs = 0;
      _fwTsWrapOffset = 0;
      _latencySyncBrowserTs = null;
      _latencySyncFwTs = null;
    }

    try {
      _rxBuffer.clear();
      _expectedPacketSize = 239; // Reset to default
      await dataCharacteristic!.setNotifyValue(true);
      _dataSubscription?.cancel();
      _dataSubscription = dataCharacteristic!.onValueReceived.listen((bytes) {
        if (!isReading) return;
        if (bytes.length >= 239 && bytes.length <= 245) {
          _expectedPacketSize = bytes.length;
          _rxBuffer.clear();
          if (isCalibrating) {
            _processCalibrationBytes(bytes);
          } else {
            _processTelemetryBytes(bytes);
          }
        } else {
          _rxBuffer.addAll(bytes);
          while (_rxBuffer.length >= _expectedPacketSize) {
            final packet = _rxBuffer.sublist(0, _expectedPacketSize);
            if (isCalibrating) {
              _processCalibrationBytes(packet);
            } else {
              _processTelemetryBytes(packet);
            }
            _rxBuffer.removeRange(0, _expectedPacketSize);
          }
        }
      });
      isReading = true;
      notifyListeners();

      if (timedRunEnabled && !isReconnect) {
        _startTimedRunTimer();
      }
    } catch (e) {
      isReading = false;
      notifyListeners();
      rethrow;
    }
  }

  Future<void> stopReading() async {
    shouldAutoReconnect = false;
    _timedRunTimer?.cancel();
    _timedRunTimer = null;
    
    _dataSubscription?.cancel();
    _dataSubscription = null;
    _rxBuffer.clear();
    
    if (dataCharacteristic != null) {
      try {
        await dataCharacteristic!.setNotifyValue(false);
      } catch (e) {
        debugPrint("Error disabling notify: $e");
      }
    }
    
    isReading = false;
    notifyListeners();
  }

  // Process normal telemetry bytes (Rev 9 Format)
  void _processTelemetryBytes(List<int> packet) {
    final data = Uint8List.fromList(packet);
    final byteData = ByteData.sublistView(data);
    final receiveTime = DateTime.now().millisecondsSinceEpoch;

    // Header info (Rev 9): packet_counter (4 bytes)
    final int packetCounter = byteData.getUint32(0, Endian.little);
    const int samplesPerPacket = 29;
    const int sampleSize = 8;

    for (int i = 0; i < samplesPerPacket; i++) {
      final offset = 5 + (i * sampleSize);
      int relativeTimestamp = byteData.getUint16(offset, Endian.little);
      final int rawX = byteData.getInt16(offset + 2, Endian.little);
      final int rawY = byteData.getInt16(offset + 4, Endian.little);
      final int rawZ = byteData.getInt16(offset + 6, Endian.little);

      // Unwrap 16-bit hardware timestamp
      if (relativeTimestamp < _lastFwTs - 30000) {
        _fwTsWrapOffset += 65536;
      }
      _lastFwTs = relativeTimestamp;
      relativeTimestamp += _fwTsWrapOffset;

      // Packet counter + sample index for sample tracking
      final int sampleCounter = packetCounter * samplesPerPacket + i;

      // Track dropped packets
      if (_lastSampleCounter > 0) {
        final int expected = (_lastSampleCounter + 1) & 0xFFFF;
        if ((sampleCounter & 0xFFFF) != expected && sampleCounter > _lastSampleCounter) {
          final int dropped = sampleCounter - _lastSampleCounter - 1;
          droppedSamples += dropped;
        }
      }
      _lastSampleCounter = sampleCounter;

      // Convert raw to g and subtract offsets
      final double ax = (rawX / lsbPerG) - calibOffsetX;
      final double ay = (rawY / lsbPerG) - calibOffsetY;
      final double az = (rawZ / lsbPerG) - calibOffsetZ;

      // Timeline mapping
      final double t = sampleCount / samplingRate.toDouble();
      sampleCount++;

      // Push to persistent storage
      receivedData.add(AccelDataPoint(
        timeSec: t,
        rawTimestamp: relativeTimestamp,
        x: ax,
        y: ay,
        z: az,
      ));

      // Push to rolling history arrays (limit size to 8192 points ~ 8 seconds to prevent memory issues)
      xHistory.add(ax);
      yHistory.add(ay);
      zHistory.add(az);
      timeHistory.add(t);

      if (xHistory.length > 8192) {
        xHistory.removeAt(0);
        yHistory.removeAt(0);
        zHistory.removeAt(0);
        timeHistory.removeAt(0);
      }

      // E2E Latency calculation (last sample in packet)
      if (i == samplesPerPacket - 1) {
        if (_latencySyncBrowserTs == null) {
          _latencySyncBrowserTs = receiveTime;
          _latencySyncFwTs = relativeTimestamp;
        } else {
          final int fwElapsedMs = relativeTimestamp - _latencySyncFwTs!;
          final int expectedBrowserTime = _latencySyncBrowserTs! + fwElapsedMs;
          final double latency = (receiveTime - expectedBrowserTime).toDouble();

          if (latency >= 0 && latency < 5000) {
            latencyHistory.add(latency);
            if (latencyHistory.length > 100) {
              latencyHistory.removeAt(0);
            }
            latencyCurrent = latency;
            latencyAvg = latencyHistory.reduce((a, b) => a + b) / latencyHistory.length;
            if (latency > latencyMax) {
              latencyMax = latency;
            }
          }
        }
      }
    }
    notifyListeners();
  }

  // Timed Run Countdown logic
  void _startTimedRunTimer() {
    final startTime = DateTime.now().millisecondsSinceEpoch;
    _timedRunTimer?.cancel();
    _timedRunTimer = Timer.periodic(const Duration(milliseconds: 100), (timer) {
      final double elapsed = (DateTime.now().millisecondsSinceEpoch - startTime) / 1000.0;
      timedRunRemainingSec = math.max(0.0, timedDurationSec - elapsed);
      
      if (timedRunRemainingSec <= 0.0) {
        stopReading();
      } else {
        notifyListeners();
      }
    });
  }

  // --- CALIBRATION SYSTEMS ---

  Future<void> startCalibration(String type) async {
    if (isCalibrating) return;
    
    // Auto-stop regular streaming
    if (isReading) {
      await stopReading();
    }

    calibrationType = type;
    isCalibrating = true;
    calibrationSamples.clear();
    calibrationProgress = 0.0;
    
    if (type == "tare") {
      calibrationRemainingSec = 3.0;
    } else {
      calibrationRemainingSec = 10.0;
    }
    notifyListeners();

    try {
      _rxBuffer.clear();
      _expectedPacketSize = 239; // Reset to default
      await dataCharacteristic!.setNotifyValue(true);
      _dataSubscription?.cancel();
      _dataSubscription = dataCharacteristic!.onValueReceived.listen((bytes) {
        if (!isCalibrating) return;
        if (bytes.length >= 239 && bytes.length <= 245) {
          _expectedPacketSize = bytes.length;
          _rxBuffer.clear();
          _processCalibrationBytes(bytes);
        } else {
          _rxBuffer.addAll(bytes);
          while (_rxBuffer.length >= _expectedPacketSize) {
            final packet = _rxBuffer.sublist(0, _expectedPacketSize);
            _processCalibrationBytes(packet);
            _rxBuffer.removeRange(0, _expectedPacketSize);
          }
        }
      });
    } catch (e) {
      isCalibrating = false;
      notifyListeners();
      rethrow;
    }
  }

  void _processCalibrationBytes(List<int> packet) {
    final data = Uint8List.fromList(packet);
    final byteData = ByteData.sublistView(data);
    const int samplesPerPacket = 29;
    const int sampleSize = 8;

    for (int i = 0; i < samplesPerPacket; i++) {
      final offset = 5 + (i * sampleSize);
      final int rawX = byteData.getInt16(offset + 2, Endian.little);
      final int rawY = byteData.getInt16(offset + 4, Endian.little);
      final int rawZ = byteData.getInt16(offset + 6, Endian.little);

      final double gx = rawX / lsbPerG;
      final double gy = rawY / lsbPerG;
      final double gz = rawZ / lsbPerG;

      calibrationSamples.add([gx, gy, gz]);
    }

    final double totalRequiredSamples = calibrationRemainingSec * samplingRate;
    calibrationProgress = math.min(1.0, calibrationSamples.length / totalRequiredSamples);
    
    if (calibrationSamples.length >= totalRequiredSamples) {
      _finishCalibration();
    } else {
      notifyListeners();
    }
  }

  Future<void> _finishCalibration() async {
    isCalibrating = false;
    _dataSubscription?.cancel();
    
    try {
      await dataCharacteristic!.setNotifyValue(false);
    } catch (e) {
      debugPrint("Error stopping notification: $e");
    }

    final n = calibrationSamples.length;
    if (n < 500) {
      notifyListeners();
      return;
    }

    double sumX = 0.0, sumY = 0.0, sumZ = 0.0;
    for (var sample in calibrationSamples) {
      sumX += sample[0];
      sumY += sample[1];
      sumZ += sample[2];
    }
    final double meanX = sumX / n;
    final double meanY = sumY / n;
    final double meanZ = sumZ / n;

    if (calibrationType == "noise") {
      // Compute RMS standard deviation
      double varX = 0.0, varY = 0.0, varZ = 0.0;
      for (var sample in calibrationSamples) {
        varX += math.pow(sample[0] - meanX, 2.0);
        varY += math.pow(sample[1] - meanY, 2.0);
        varZ += math.pow(sample[2] - meanZ, 2.0);
      }
      noiseFloorX = math.sqrt(varX / n);
      noiseFloorY = math.sqrt(varY / n);
      noiseFloorZ = math.sqrt(varZ / n);
    } else if (calibrationType == "tare") {
      // Flat stationary tare offset calibration
      calibOffsetX = meanX;
      calibOffsetY = meanY;
      calibOffsetZ = meanZ - 1.0; // Subtract 1g gravity in Z
    }

    await _saveCalibrationData();
    notifyListeners();
  }

  // Local storage management via file system
  Future<void> _saveCalibrationData() async {
    try {
      final dir = await getApplicationDocumentsDirectory();
      final file = File('${dir.path}/calibration_config.json');
      final data = {
        'calibOffsetX': calibOffsetX,
        'calibOffsetY': calibOffsetY,
        'calibOffsetZ': calibOffsetZ,
        'noiseFloorX': noiseFloorX,
        'noiseFloorY': noiseFloorY,
        'noiseFloorZ': noiseFloorZ,
      };
      await file.writeAsString(jsonEncode(data));
    } catch (e) {
      debugPrint("Error saving calibration: $e");
    }
  }

  Future<void> _loadCalibrationData() async {
    try {
      final dir = await getApplicationDocumentsDirectory();
      final file = File('${dir.path}/calibration_config.json');
      if (await file.exists()) {
        final data = jsonDecode(await file.readAsString());
        calibOffsetX = data['calibOffsetX'] ?? 0.0;
        calibOffsetY = data['calibOffsetY'] ?? 0.0;
        calibOffsetZ = data['calibOffsetZ'] ?? 0.0;
        noiseFloorX = data['noiseFloorX'] ?? 0.0563;
        noiseFloorY = data['noiseFloorY'] ?? 0.0563;
        noiseFloorZ = data['noiseFloorZ'] ?? 0.0563;
        notifyListeners();
      }
    } catch (e) {
      debugPrint("Error loading calibration: $e");
    }
  }

  // --- CSV SAVE & EXPORT ---

  Future<void> shareCsvFile(String inputFileName) async {
    final fileName = inputFileName.trim().isEmpty ? "accel_data" : inputFileName.trim();
    
    // Build CSV Content
    final buffer = StringBuffer();
    buffer.writeln("Time(s),DeviceTs(ms),X(g),Y(g),Z(g)");
    
    for (var pt in receivedData) {
      buffer.writeln("${pt.timeSec.toStringAsFixed(4)},${pt.rawTimestamp},${pt.x.toStringAsFixed(4)},${pt.y.toStringAsFixed(4)},${pt.z.toStringAsFixed(4)}");
    }

    try {
      final dir = await getTemporaryDirectory();
      final file = File("${dir.path}/$fileName.csv");
      await file.writeAsString(buffer.toString());

      // Use share_plus to export the file
      final XFile xFile = XFile(file.path);
      await Share.shareXFiles([xFile], text: "Smart Accelerometer BLE Data Export");
    } catch (e) {
      debugPrint("Error exporting CSV: $e");
    }
  }

  // --- HARDWARE CONFIGURATION FUNCTIONS ---

  void _updateLSBPerG(int rangeG) {
    if (activeSensor == "ADXL345") {
      lsbPerG = 256.0; // ADXL345 in Full Resolution is 256 LSB/g (3.9 mg/LSB)
    } else { // H3LIS331DL
      if (rangeG == 100) {
        lsbPerG = 327.68;
      } else if (rangeG == 200) {
        lsbPerG = 163.84;
      } else {
        lsbPerG = 81.92; // 400g default
      }
    }
    notifyListeners();
  }

  Future<void> writeSamplingRate(int rate) async {
    if (sampleRateCharacteristic == null) return;
    try {
      final data = Uint8List(2);
      final byteData = ByteData.sublistView(data);
      byteData.setUint16(0, rate, Endian.little);
      await sampleRateCharacteristic!.write(data, withoutResponse: false);
      samplingRate = rate;
      notifyListeners();
    } catch (e) {
      debugPrint("Failed to write sampling rate: $e");
    }
  }

  Future<void> writeTxPower(int dbmValue) async {
    if (txPowerCharacteristic == null) return;
    try {
      final data = Int8List.fromList([dbmValue]);
      await txPowerCharacteristic!.write(Uint8List.view(data.buffer), withoutResponse: false);
      txPower = dbmValue;
      notifyListeners();
    } catch (e) {
      debugPrint("Failed to write TX power: $e");
    }
  }

  Future<void> writeGRange(int rangeValue) async {
    if (modeCharacteristic == null) return;
    int cmdByte = 0x22; // ±400g default
    if (rangeValue == 100) cmdByte = 0x20;
    else if (rangeValue == 200) cmdByte = 0x21;
    else if (rangeValue == 400) cmdByte = 0x22;
    else if (rangeValue == 16) cmdByte = 0x23;
    else if (rangeValue == 8) cmdByte = 0x24;
    else if (rangeValue == 4) cmdByte = 0x25;
    else if (rangeValue == 2) cmdByte = 0x26;

    try {
      await modeCharacteristic!.write([cmdByte], withoutResponse: false);
      rangeG = rangeValue;
      _updateLSBPerG(rangeG);
      notifyListeners();
    } catch (e) {
      debugPrint("Failed to write G-range: $e");
    }
  }

  Future<void> toggleEcoMode(bool enable) async {
    if (enable) {
      // Activating eco mode (Client-side macro)
      await writeSamplingRate(1024);
      await writeBufferMode("0x10"); // No Buffer
      final txDbm = isNrfDevice ? -8 : -12;
      await writeTxPower(txDbm);
      ecoMode = true;
    } else {
      // Deactivating eco mode
      await writeSamplingRate(1024);
      await writeTxPower(0);
      ecoMode = false;
    }
    notifyListeners();
  }

  // Active sensor setter (from UI)
  Future<void> selectSensor(String targetSensor) async {
    activeSensor = targetSensor;
    final defaultRange = (targetSensor == "H3LIS331DL") ? 400 : 16;
    await writeGRange(defaultRange);
  }
}
