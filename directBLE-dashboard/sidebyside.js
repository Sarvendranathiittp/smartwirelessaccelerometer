document.addEventListener('DOMContentLoaded', () => {
    let sineData = [];
    let isReading = false;
    let sineCharacteristic;
    let timeChart;
    let startTime;
    let connectedDevice;
    const MAX_DATA_POINTS = 100; // for moving chart

    initChart();

    function startReading() {
        if (!isReading) {
            isReading = true;
            startTime = Date.now();
            sineData = [];
            toggleButtonState('startButton', false);
            toggleButtonState('stopButton', true);
            toggleButtonState('exportButton', false);

            sineCharacteristic.startNotifications().then(char => {
                char.addEventListener('characteristicvaluechanged', handleSineData);
            });

            sendStartSignal();
        }
    }

    function stopReading() {
        if (isReading) {
            isReading = false;
            toggleButtonState('startButton', true);
            toggleButtonState('stopButton', false);
            toggleButtonState('exportButton', true);

            sineCharacteristic.stopNotifications().then(() => {
                console.log('Notifications stopped');
            });
        }
    }

    function handleSineData(event) {
        if (!startTime) {
            startTime = Date.now(); // Set start time when first packet received
        }

        const value = event.target.value;
        const dv = new DataView(value.buffer);

        const packetNumber = dv.getUint32(0, true); // First 4 bytes: packet number

        const floatArray = [];
        for (let i = 4; i < value.byteLength; i += 4) {
            if (i + 4 <= value.byteLength) {
                floatArray.push(dv.getFloat32(i, true));
            }
        }

        const elapsedMilliseconds = Date.now() - startTime;
        const formattedTime = formatElapsedTime(elapsedMilliseconds);

        console.log([${formattedTime}] Packet ${packetNumber} received. ${floatArray.length} values);

        sineData.push({
            packet: packetNumber,
            timestamp: formattedTime,
            values: floatArray
        });

        document.getElementById('sineValue').textContent =
            Packet ${packetNumber}: ${floatArray.length} sine values;

        updateTimeChart(floatArray);
    }

    function updateTimeChart(values) {
        const chartData = timeChart.data.datasets[0].data;

        for (let i = 0; i < values.length; i++) {
            chartData.push(values[i]);
            if (chartData.length > MAX_DATA_POINTS) {
                chartData.shift();
            }
        }

        timeChart.data.labels = chartData.map((_, i) => i);
        timeChart.update();
    }

    function initChart() {
        const ctx = document.getElementById('timeChart').getContext('2d');
        timeChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: 'Sine Wave',
                    data: [],
                    borderColor: 'rgba(75, 192, 192, 1)',
                    borderWidth: 2,
                    fill: false,
                    pointRadius: 0
                }]
            },
            options: {
                responsive: true,
                animation: false,
                scales: {
                    x: {
                        title: { display: true, text: 'Samples' }
                    },
                    y: {
                        title: { display: true, text: 'Amplitude' }
                    }
                }
            }
        });
    }

    async function sendStartSignal() {
        const service = await connectedDevice.gatt.getPrimaryService('f3641400-00b0-4240-ba50-05ca45bf8abc');
        const controlChar = await service.getCharacteristic('f3641402-00b0-4240-ba50-05ca45bf8abc');
        const encoder = new TextEncoder();
        await controlChar.writeValue(encoder.encode("START"));
        console.log("[BLE] START signal sent to Nicla");
    }

    function toggleButtonState(buttonId, isEnabled) {
        const button = document.getElementById(buttonId);
        if (button) button.disabled = !isEnabled;
    }

    async function exportToExcel() {
        const fileName = document.getElementById('file-name').value || 'sine_wave_data';
        const wsData = [["Packet", "Timestamp", ...Array.from({ length: 56 }, (_, i) => Value${i + 1})]];

        sineData.forEach(entry => {
            wsData.push([
                entry.packet,
                entry.timestamp,
                ...entry.values
            ]);
        });

        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet(wsData);
        XLSX.utils.book_append_sheet(wb, ws, 'SineData');
        XLSX.writeFile(wb, ${fileName}.xlsx);
    }

    function formatElapsedTime(ms) {
        const totalSeconds = Math.floor(ms / 1000);
        const milliseconds = ms % 1000;
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        return (
            String(hours).padStart(2, '0') + ':' +
            String(minutes).padStart(2, '0') + ':' +
            String(seconds).padStart(2, '0') + '.' +
            String(milliseconds).padStart(3, '0')
        );
    }

    // Event Listeners
    document.getElementById('connectButton').addEventListener('click', async () => {
        try {
            const device = await navigator.bluetooth.requestDevice({
                filters: [{ namePrefix: 'ESP32' }],
                optionalServices: ['f3641400-00b0-4240-ba50-05ca45bf8abc']
            });

            connectedDevice = device;
            const server = await device.gatt.connect();
            const service = await server.getPrimaryService('f3641400-00b0-4240-ba50-05ca45bf8abc');
            sineCharacteristic = await service.getCharacteristic('f3641401-00b0-4240-ba50-05ca45bf8abc');

            toggleButtonState('connectButton', false);
            toggleButtonState('startButton', true);
        } catch (error) {
            console.error('Failed to connect to device:', error);
        }
    });

    document.getElementById('startButton').addEventListener('click', startReading);
    document.getElementById('stopButton').addEventListener('click', stopReading);
    document.getElementById('exportButton').addEventListener('click', exportToExcel);
});