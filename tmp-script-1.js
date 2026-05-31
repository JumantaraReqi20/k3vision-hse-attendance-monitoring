
        // ===== CONFIG =====
        const API = window.location.origin;
        let streams = {};
        let monRunning = false;
        let monRefreshTimer = null;
        let monLastStateSignature = '';
        const seenMonitorEvents = new Set();
        const MONITOR_REFRESH_MS = 30000;
        let regBlob = null;
        let regPreviewUrl = null;
        let attBlob = null;
        let selectedCameraId = localStorage.getItem('selectedCameraId') || '';

        // ===== CAMERA ENUMERATION & SELECTION =====
        async function enumerateCameras() {
            try {
                const devices = await navigator.mediaDevices.enumerateDevices();
                const videoInputs = devices.filter(device => device.kind === 'videoinput');
                const cameraSelect = document.getElementById('cameraSelect');
                
                // Clear existing options except the first one
                while (cameraSelect.options.length > 1) {
                    cameraSelect.remove(1);
                }
                
                // Add all available cameras
                videoInputs.forEach((device, index) => {
                    const option = document.createElement('option');
                    option.value = device.deviceId;
                    option.text = device.label || `Camera ${index + 1}`;
                    cameraSelect.appendChild(option);
                });
                
                // Restore previously selected camera or use default
                if (selectedCameraId && [...cameraSelect.options].some(opt => opt.value === selectedCameraId)) {
                    cameraSelect.value = selectedCameraId;
                } else if (videoInputs.length > 0) {
                    // Prefer external camera (usually not index 0)
                    cameraSelect.value = videoInputs.length > 1 ? videoInputs[1].deviceId : videoInputs[0].deviceId;
                    selectedCameraId = cameraSelect.value;
                }
            } catch (e) {
                console.error('Error enumerating cameras:', e);
            }
        }

        // Enumerate cameras on page load
        document.addEventListener('DOMContentLoaded', enumerateCameras);

        // Listen for camera selection change
        document.getElementById('cameraSelect').addEventListener('change', (e) => {
            selectedCameraId = e.target.value;
            localStorage.setItem('selectedCameraId', selectedCameraId);
            
            // Reinitialize camera for active page
            const activePage = document.querySelector('.page.active')?.id;
            if (['attendance', 'register'].includes(activePage)) {
                initCamera(activePage);
            }
        });

        // Re-enumerate cameras when permissions might have changed
        navigator.mediaDevices.addEventListener('devicechange', enumerateCameras);

        // ===== REALTIME CLOCK =====
        function updateClock() {
            const now = new Date();
            document.getElementById('realtimeClock').textContent = 
                now.toLocaleTimeString('id-ID', { hour12: false });
        }
        setInterval(updateClock, 1000);
        updateClock();

        // ===== SIDEBAR TOGGLE =====
        document.getElementById('sidebarToggle').addEventListener('click', () => {
            document.getElementById('sidebar').classList.toggle('collapsed');
        });

        // ===== NAVIGATION =====
        document.querySelectorAll('.nav-item').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.nav-item').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
                
                tab.classList.add('active');
                const target = tab.dataset.target;
                document.getElementById(target).classList.add('active');
                
                // Init camera for relevant pages
                if (['attendance', 'register'].includes(target)) {
                    initCamera(target);
                }

                // Load data for dashboard pages
                if (target === 'dashboard') loadDashboardStats();
                if (target === 'attendance') loadLatestAttendance();
                if (target === 'workers') loadWorkers();
                if (target === 'history') loadHistory();
                if (target === 'daily-attendance') loadDailyAttendance();
                if (target === 'reports') loadReport();
                if (target === 'monitor') loadMonitorPage();
            });
        });

        // ===== CAMERA INIT =====
        async function initCamera(section) {
            if (section === 'monitor') return;
            const videoId = section === 'register' ? 'regVideo' : 
                           section === 'attendance' ? 'attVideo' : 'monVideo';
            const video = document.getElementById(videoId);
            
            // Stop existing stream
            if (streams[section]) {
                streams[section].getTracks().forEach(t => t.stop());
            }
            
            try {
                // Camera constraints with selected device
                const constraints = { 
                    video: { 
                        width: { ideal: 1280 },
                        height: { ideal: 720 },
                        facingMode: 'user'
                    } 
                };
                
                // If a camera is selected, use its deviceId
                if (selectedCameraId) {
                    constraints.video.deviceId = { exact: selectedCameraId };
                }
                
                streams[section] = await navigator.mediaDevices.getUserMedia(constraints);
                video.srcObject = streams[section];
                
                // Update status indicator
                const statusEl = document.getElementById('cameraStatus');
                if (statusEl) {
                    statusEl.classList.add('active');
                    const selectedOption = document.querySelector(`#cameraSelect option[value="${selectedCameraId}"]`);
                    const cameraName = selectedOption ? selectedOption.text : 'Camera';
                    statusEl.querySelector('span:last-child').textContent = `Camera: ${cameraName}`;
                }
            } catch (e) { 
                console.error('Camera error:', e);
                alert('⚠️ Kamera tidak dapat diakses. Pastikan izin kamera diberikan dan kamera terpilih tersedia.'); 
            }
        }

        // ===== CAPTURE FRAME =====
        async function captureFrame(video, mirror = true) {
            const canvas = document.getElementById('hiddenCanvas');
            canvas.width = video.videoWidth || 640;
            canvas.height = video.videoHeight || 480;
            const ctx = canvas.getContext('2d');
            
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.save();
            if (mirror) {
                ctx.translate(canvas.width, 0);
                ctx.scale(-1, 1);
            }
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            ctx.restore();
            
            return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
        }

        // ===== API HELPER =====
        async function post(endpoint, blob, fields = {}) {
            const fd = new FormData();
            fd.append('file', blob, 'frame.jpg');
            Object.entries(fields).forEach(([k, v]) => {
                if (v) fd.append(k, v);
            });
            
            const res = await fetch(`${API}${endpoint}`, { 
                method: 'POST', 
                body: fd,
                headers: { 'Accept': 'application/json' }
            });
            
            if (!res.ok) { 
                const err = await res.json().catch(() => ({})); 
                throw new Error(err.detail || `HTTP ${res.status}`); 
            }
            return res.json();
        }

        async function get(endpoint) {
            const res = await fetch(`${API}${endpoint}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        }

        // ===== DRAW BOXES ON CANVAS =====
        async function drawBoxes(boxes, video, canvas) {
            const ctx = canvas.getContext('2d');
            canvas.width = video.videoWidth || 640;
            canvas.height = video.videoHeight || 480;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            
            if (!boxes?.length) return;
            
            ctx.lineWidth = 3;
            ctx.font = '600 14px Inter, sans-serif';
            const colors = { 
                human: '#00ffcc', 
                helmet: '#ff4444', 
                vest: '#44aaff', 
                boots: '#ffcc44',
                gloves: '#aa44ff'
            };
            
            boxes.forEach(b => {
                const color = colors[b.label] || '#ffffff';
                const x1 = b.x1;
                const y1 = b.y1;
                const x2 = b.x2;
                const y2 = b.y2;
                const boxWidth = x2 - x1;
                const boxHeight = y2 - y1;
                ctx.strokeStyle = color;
                ctx.fillStyle = color;
                
                // Draw box
                ctx.strokeRect(x1, y1, boxWidth, boxHeight);
                
                // Draw label background & text
                const label = `${b.label} ${(b.conf * 100).toFixed(0)}%`;
                const textMetrics = ctx.measureText(label);
                const labelHeight = 24;
                const labelY = Math.max(0, y1 - labelHeight);
                
                ctx.fillStyle = color;
                ctx.fillRect(x1, labelY, textMetrics.width + 12, labelHeight);
                
                ctx.fillStyle = '#0f172a';
                ctx.fillText(label, x1 + 6, labelY + 17);
            });
        }

        function showAnnotatedFrame(base64Image, imageEl) {
            if (!base64Image) {
                imageEl.removeAttribute('src');
                imageEl.style.display = 'none';
                return;
            }

            imageEl.src = `data:image/jpeg;base64,${base64Image}`;
            imageEl.style.display = 'block';
        }

        function hideAnnotatedFrame(imageEl) {
            if (!imageEl) return;
            imageEl.removeAttribute('src');
            imageEl.style.display = 'none';
        }

        function resetStatusBadge(id, label) {
            const el = document.getElementById(id);
            if (!el) return;

            el.className = 'status-badge';
            const dot = el.querySelector('.status-badge__dot');
            const text = el.querySelector('span:last-child');

            if (dot) dot.style.background = '';
            if (text) text.textContent = label;
        }

        function resetAttendanceInference() {
            hideAnnotatedFrame(document.getElementById('attAnnotated'));
            document.getElementById('attResult')?.classList.remove('show', 'accepted', 'rejected');
            document.getElementById('attWorkerDetected').style.display = 'none';
            document.getElementById('attWorkerName').textContent = 'Worker: -';
            document.getElementById('attRecording').style.display = 'none';

            resetStatusBadge('attHelmStatus', '🪖 Helmet: -');
            resetStatusBadge('attVestStatus', '🦺 Vest: -');
            resetStatusBadge('attBootsStatus', '👢 Boots: -');

            ['sideHelm', 'sideVest', 'sideBoots'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.className = 'ppe-item ok';
            });

            document.getElementById('sideResult').innerHTML = '<p class="text-muted">Silakan scan untuk melihat hasil</p>';
        }

        function resetMonitoringInference() {
            hideAnnotatedFrame(document.getElementById('monAnnotated'));
            const monPersonDetectedEl = document.getElementById('monPersonDetected');
            if (monPersonDetectedEl) monPersonDetectedEl.style.display = 'none';
            document.getElementById('monWarning')?.classList.remove('show');
            const alertBadgeEl = document.getElementById('alertBadge');
            if (alertBadgeEl) alertBadgeEl.style.display = 'none';

            resetStatusBadge('monHelmBadge', '🪖 Helmet');
            resetStatusBadge('monVestBadge', '🦺 Vest');
            resetStatusBadge('monBootsBadge', '👢 Boots');
        }

        // ===== DASHBOARD STATS =====
        async function loadDashboardStats() {
            try {
                const stats = await get('/dashboard/stats');
                
                document.getElementById('statWorkers').textContent = stats.total_workers || '-';
                document.getElementById('statToday').textContent = stats.attendance_today || '-';
                document.getElementById('statAccepted').textContent = stats.accepted_today || '-';
                document.getElementById('statRejected').textContent = stats.rejected_today || '-';
                
                // Compliance ring
                const pct = stats.compliance_rate || 0;
                document.getElementById('complianceRing').style.setProperty('--pct', `${pct}%`);
                document.getElementById('complianceValue').textContent = `${pct}%`;
                
                // PPE stats
                document.getElementById('ppeHelmStat').textContent = `🪖 Helm: ${stats.ppe_compliance?.helmet || 0}%`;
                document.getElementById('ppeVestStat').textContent = `🦺 Rompi: ${stats.ppe_compliance?.vest || 0}%`;
                document.getElementById('ppeBootsStat').textContent = `👢 Sepatu: ${stats.ppe_compliance?.boots || 0}%`;
                
                // Recent activity from API
                const activityEl = document.getElementById('recentActivity');
                try {
                    const historyData = await get('/attendance/history?limit=5');
                    
                    if (historyData.records && historyData.records.length > 0) {
                        activityEl.innerHTML = historyData.records.map(r => {
                            const time = new Date(r.timestamp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
                            const statusClass = r.status === 'accepted' ? 'accepted' : 'rejected';
                            const statusIcon = r.status === 'accepted' ? '✅' : '❌';
                            return `
                                <div class="log-item">
                                    <span class="log-item__name">${r.name}</span>
                                    <span class="log-item__time">${time}</span>
                                    <span class="log-item__status ${statusClass}">${statusIcon} ${r.status}</span>
                                </div>
                            `;
                        }).join('');
                    } else {
                        activityEl.innerHTML = '<div class="text-center text-muted" style="padding:20px">Belum ada data kehadiran hari ini</div>';
                    }
                } catch (historyErr) {
                    // Fallback to empty state if history API fails
                    activityEl.innerHTML = '<div class="text-center text-muted" style="padding:20px">Tidak dapat memuat aktivitas terbaru</div>';
                    console.warn('Could not load activity history:', historyErr);
                }
            } catch (e) {
                console.warn('Dashboard stats error:', e);
            }
        }

        async function loadLatestAttendance() {
            const lastAttEl = document.getElementById('lastAttendance');
            if (!lastAttEl) return;

            try {
                const data = await get('/attendance/history?limit=5');

                if (!data.records?.length) {
                    lastAttEl.innerHTML = '<div class="text-center text-muted" style="padding:12px">Belum ada absensi</div>';
                    return;
                }

                lastAttEl.innerHTML = data.records.map(r => {
                    const time = new Date(r.timestamp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
                    return `
                        <div class="log-item">
                            <span class="log-item__name">${r.name}</span>
                            <span class="log-item__time">${time}</span>
                            <span class="log-item__status ${r.status}">${r.status}</span>
                        </div>
                    `;
                }).join('');
            } catch (e) {
                console.warn('Latest attendance error:', e);
                lastAttEl.innerHTML = '<div class="text-center text-muted" style="padding:12px">Tidak dapat memuat absensi terakhir</div>';
            }
        }

        async function refreshAppViews(sourceButton = null, options = {}) {
            const shouldResetInference = options.resetInference !== false;
            const refreshBtn = document.getElementById('btnRefreshView');
            const activePage = document.querySelector('.page.active')?.id;
            const activeFilter = document.querySelector('[data-filter].btn-primary')?.dataset.filter || 'all';
            const dailyDate = document.getElementById('dailyAttendanceDate')?.value;
            const buttons = [...new Set([refreshBtn, sourceButton].filter(Boolean))];
            const runRefreshTask = async (taskName, task) => {
                try {
                    await task();
                } catch (error) {
                    console.warn(`Refresh ${taskName} gagal:`, error);
                }
            };

            buttons.forEach(button => {
                button.disabled = true;
                button.dataset.originalText = button.textContent;
                button.textContent = 'Refreshing...';
            });

            try {
                if (shouldResetInference) {
                    resetAttendanceInference();
                    resetMonitoringInference();
                }

                await runRefreshTask('dashboard', loadDashboardStats);
                await runRefreshTask('absensi terakhir', loadLatestAttendance);
                await runRefreshTask('pekerja', loadWorkers);
                await runRefreshTask('riwayat', () => loadHistory(activeFilter));

                if (dailyDate) {
                    await runRefreshTask('status harian', loadDailyAttendance);
                }

                if (activePage === 'reports') {
                    await runRefreshTask('laporan', loadReport);
                }
            } finally {
                buttons.forEach(button => {
                    button.disabled = false;
                    button.textContent = button.dataset.originalText || 'Refresh Data';
                    delete button.dataset.originalText;
                });
            }
        }

        document.getElementById('btnRefreshView')?.addEventListener('click', (event) => {
            refreshAppViews(event.currentTarget);
        });

        document.addEventListener('click', (event) => {
            const refreshButton = event.target.closest('[data-action="refresh-view"]');
            if (!refreshButton) return;
            refreshAppViews(refreshButton);
        });

        function showAttendanceRefreshButton() {
            const refreshBtn = document.getElementById('btnRefreshView');
            if (refreshBtn) refreshBtn.style.display = 'inline-flex';
        }

        // ===== WORKERS LIST =====
        async function loadWorkers() {
            try {
                const data = await get('/workers');
                const tbody = document.getElementById('workersTableBody');
                
                if (!data.workers?.length) {
                    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted" style="padding:24px">👤 Belum ada pekerja terdaftar</td></tr>';
                    return;
                }
                
                tbody.innerHTML = data.workers.map((w, i) => `
                    <tr>
                        <td>${i + 1}</td>
                        <td class="fw-600">${w.name}</td>
                        <td>${w.department || '-'}</td>
                        <td>${w.position || '-'}</td>
                        <td>${w.email || '-'}</td>
                        <td>${w.phone || '-'}</td>
                        <td><span class="status-badge status-badge--ok" style="padding:4px 10px;font-size:0.75rem">✅ Active</span></td>
                    </tr>
                `).join('');
            } catch (e) {
                console.error('Load workers error:', e);
                document.getElementById('workersTableBody').innerHTML = 
                    '<tr><td colspan="7" class="text-center text-danger" style="padding:24px">❌ Gagal memuat data</td></tr>';
            }
        }

        // ===== ATTENDANCE HISTORY =====
        async function loadHistory(filter = 'all') {
            try {
                const statusParam = filter && filter !== 'all' ? `&status=${filter}` : '';
                const data = await get(`/attendance/history?limit=50${statusParam}`);
                const tbody = document.getElementById('historyTableBody');
                
                if (!data.records?.length) {
                    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted" style="padding:24px">📋 Belum ada data kehadiran</td></tr>';
                    return;
                }
                
                tbody.innerHTML = data.records.map((r, i) => `
                    <tr>
                        <td>${i + 1}</td>
                        <td class="fw-600">${r.name}</td>
                        <td>${new Date(r.timestamp).toLocaleString('id-ID')}</td>
                        <td><span class="log-item__status ${r.status}">${r.status}</span></td>
                        <td>${r.helmet ? '✅' : '❌'}</td>
                        <td>${r.vest ? '✅' : '❌'}</td>
                        <td>${r.boots ? '✅' : '❌'}</td>
                    </tr>
                `).join('');
            } catch (e) {
                console.error('Load history error:', e);
            }
        }

        // History filter buttons
        document.querySelectorAll('[data-filter]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('[data-filter]').forEach(b => {
                    b.classList.remove('btn-primary');
                    b.classList.add('btn-outline');
                });
                e.target.classList.remove('btn-outline');
                e.target.classList.add('btn-primary');
                loadHistory(e.target.dataset.filter);
            });
        });

        // ===== DAILY ATTENDANCE =====
        async function loadDailyAttendance() {
            const dateInput = document.getElementById('dailyAttendanceDate');
            const selectedDate = dateInput.value;
            
            if (!selectedDate) {
                alert('Pilih tanggal terlebih dahulu');
                return;
            }
            
            const loading = document.getElementById('dailyAttendanceLoading');
            const tbody = document.getElementById('dailyAttendanceBody');
            const title = document.getElementById('dailyAttendanceTitle');
            
            loading.classList.add('show');
            tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted" style="padding:24px">🔄 Loading data...</td></tr>';
            
            try {
                const data = await get(`/attendance/daily-status?date=${selectedDate}`);
                
                // Update title
                const dateObj = new Date(selectedDate + 'T00:00:00');
                const dateStr = dateObj.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
                title.textContent = `Status Kehadiran - ${dateStr}`;
                
                if (!data.workers?.length) {
                    tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted" style="padding:24px">Belum ada data pekerja</td></tr>';
                    return;
                }
                
                // Calculate summary
                const total = data.workers.length;
                const present = data.workers.filter(w => w.attendance_status === 'accepted').length;
                const incomplete = data.workers.filter(w => w.attendance_status === 'rejected').length;
                const absent = data.workers.filter(w => w.attendance_status === 'absent').length;
                
                document.getElementById('dailySummaryTotal').textContent = total;
                document.getElementById('dailySummaryPresent').textContent = present;
                document.getElementById('dailySummaryAbsent').textContent = absent;
                document.getElementById('dailySummaryIncomplete').textContent = incomplete;
                
                // Build table
                tbody.innerHTML = data.workers.map((w, i) => {
                    let statusBadge = '';
                    let statusColor = '';
                    
                    if (w.attendance_status === 'accepted') {
                        statusBadge = '✅ Hadir (Lengkap)';
                        statusColor = 'accepted';
                    } else if (w.attendance_status === 'rejected') {
                        statusBadge = '⚠️ Hadir (Tidak Lengkap)';
                        statusColor = 'rejected';
                    } else {
                        statusBadge = '❌ Tidak Hadir';
                        statusColor = 'rejected';
                    }
                    
                    const time = w.timestamp ? new Date(w.timestamp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '-';
                    
                    return `
                        <tr>
                            <td>${i + 1}</td>
                            <td class="fw-600">${w.name}</td>
                            <td>${w.department || '-'}</td>
                            <td>${w.position || '-'}</td>
                            <td><span class="log-item__status ${statusColor}">${statusBadge}</span></td>
                            <td>${time}</td>
                            <td>${w.helmet !== null ? (w.helmet ? '✅' : '❌') : '-'}</td>
                            <td>${w.vest !== null ? (w.vest ? '✅' : '❌') : '-'}</td>
                            <td>${w.boots !== null ? (w.boots ? '✅' : '❌') : '-'}</td>
                        </tr>
                    `;
                }).join('');
                
            } catch (e) {
                console.error('Load daily attendance error:', e);
                tbody.innerHTML = `<tr><td colspan="9" class="text-center text-danger" style="padding:24px">❌ Error: ${e.message}</td></tr>`;
            } finally {
                loading.classList.remove('show');
            }
        }
        
        // Set default date to today
        document.addEventListener('DOMContentLoaded', () => {
            const dateInput = document.getElementById('dailyAttendanceDate');
            const today = new Date().toISOString().split('T')[0];
            dateInput.value = today;
        });
        
        // Load button
        document.getElementById('btnLoadDailyAttendance').addEventListener('click', loadDailyAttendance);
        
        // Auto load when date changes
        document.getElementById('dailyAttendanceDate').addEventListener('change', loadDailyAttendance);

        // ===== ATTENDANCE SCAN - CLIENT-SIDE INFERENCE =====
        document.getElementById('btnAttCheck').addEventListener('click', async () => {
            const video = document.getElementById('attVideo');
            const annotatedImage = document.getElementById('attAnnotated');
            const btn = document.getElementById('btnAttCheck');
            const load = document.getElementById('attLoading');
            const resBox = document.getElementById('attResult');
            const recording = document.getElementById('attRecording');
            
            btn.disabled = true;
            load.classList.add('show');
            resBox.classList.remove('show');
            recording.style.display = 'flex';
            hideAnnotatedFrame(annotatedImage);
            
            // Update overlay badges to loading state
            ['attHelmStatus', 'attVestStatus', 'attBootsStatus'].forEach(id => {
                const el = document.getElementById(id);
                el.querySelector('.status-badge__dot').style.background = 'var(--warning)';
                el.querySelector('span:last-child').textContent = el.querySelector('span:last-child').textContent.replace(/: .+$/, ': ...');
            });
            
            try {
                const blob = await captureFrame(video);
                
                // ===== CLIENT-SIDE PPE INFERENCE =====
                console.log('[Attendance] Running CLIENT-SIDE PPE detection...');
                const ppeResult = await detectPPE(blob);
                console.log('[Attendance] PPE Detection Complete:', ppeResult);
                
                if (ppeResult.error) {
                    throw new Error(ppeResult.error);
                }
                
                // ===== SERVER FACE IDENTIFICATION & VERIFICATION =====
                const fd = new FormData();
                fd.append('file', blob, 'frame.jpg');
                fd.append('ppe_helmet', ppeResult.helmet ? '1' : '0');
                fd.append('ppe_vest', ppeResult.vest ? '1' : '0');
                fd.append('ppe_boots', ppeResult.boots ? '1' : '0');
                
                const res = await fetch(`${API}/attendance/check`, { method: 'POST', body: fd });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.detail || `HTTP ${res.status}`);
                }
                const d = await res.json();
                
                // Update overlay badges with CLIENT-SIDE PPE results
                const updateBadge = (id, status, label) => {
                    const el = document.getElementById(id);
                    const dot = el.querySelector('.status-badge__dot');
                    const text = el.querySelector('span:last-child');
                    dot.style.background = status ? 'var(--success)' : 'var(--danger)';
                    el.className = `status-badge status-badge--${status ? 'ok' : 'danger'}`;
                    text.textContent = `${label}: ${status ? '✅' : '❌'}`;
                };
                
                updateBadge('attHelmStatus', ppeResult.helmet, '🪖 Helmet');
                updateBadge('attVestStatus', ppeResult.vest, '🦺 Vest');
                updateBadge('attBootsStatus', ppeResult.boots, '👢 Boots');
                
                // Update side panel
                ['sideHelm', 'sideVest', 'sideBoots'].forEach((id, idx) => {
                    const el = document.getElementById(id);
                    const status = [ppeResult.helmet, ppeResult.vest, ppeResult.boots][idx];
                    el.className = `ppe-item ${status ? 'ok' : 'missing'}`;
                });
                
                // Update worker name
                document.getElementById('attWorkerDetected').style.display = 'flex';
                document.getElementById('attWorkerName').textContent = `Worker: ${d.worker?.name || d.worker}`;
                
                // Result display
                const ppeHtml = `
                    <div class="ppe-status-grid">
                        <div class="ppe-item ${ppeResult.helmet ? 'ok' : 'missing'}">🪖 Helmet ${ppeResult.helmet ? '✅' : '❌'}</div>
                        <div class="ppe-item ${ppeResult.vest ? 'ok' : 'missing'}">🦺 Vest ${ppeResult.vest ? '✅' : '❌'}</div>
                        <div class="ppe-item ${ppeResult.boots ? 'ok' : 'missing'}">👢 Boots ${ppeResult.boots ? '✅' : '❌'}</div>
                    </div>
                `;
                
                resBox.className = `result-box ${d.attendance} show`;
                resBox.innerHTML = `
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                        <strong style="font-size:1.1rem">Worker: ${d.worker?.name || d.worker}</strong>
                        <span class="status-badge status-badge--${d.attendance === 'accepted' ? 'ok' : 'danger'}" 
                              style="padding:6px 14px;font-size:0.85rem">
                            ${d.attendance.toUpperCase()}
                        </span>
                    </div>
                    ${ppeHtml}
                    ${d.message ? `<p style="margin-top:12px;padding:10px;background:rgba(220,38,38,0.1);border-radius:8px;color:var(--danger-dark);font-weight:500">📢 ${d.message}</p>` : ''}
                `;
                
                // Side result
                document.getElementById('sideResult').innerHTML = `
                    <div style="font-size:1.2rem;font-weight:600;margin-bottom:8px" 
                         class="${d.attendance === 'accepted' ? 'text-success' : 'text-danger'}">
                        ${d.attendance === 'accepted' ? '✅ Absensi Diterima' : '❌ Absensi Ditolak'}
                    </div>
                    <p class="text-muted" style="font-size:0.9rem">${d.message || 'APD lengkap, data tersimpan'}</p>
                `;
                
                // Update last attendance
                const lastAttEl = document.getElementById('lastAttendance');
                const now = new Date().toLocaleTimeString('id-ID');
                lastAttEl.innerHTML = `
                    <div class="log-item">
                        <span class="log-item__name">${d.worker?.name || d.worker}</span>
                        <span class="log-item__time">${now}</span>
                        <span class="log-item__status ${d.attendance}">${d.attendance}</span>
                    </div>
                ` + lastAttEl.innerHTML;

                showAttendanceRefreshButton();
                refreshAppViews(null, { resetInference: false });
                
            } catch (e) {
                resBox.className = 'result-box rejected show';
                
                // Check if it's double attendance error
                const isDoubleAttendance = e.message.includes('absensi diterima hari ini') || e.message.includes('sudah absen hari ini');
                const errorIcon = isDoubleAttendance ? '⛔' : '❌';
                const errorTitle = isDoubleAttendance ? 'Sudah Absen' : 'Error';
                
                resBox.innerHTML = `
                    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
                        <span style="font-size:1.5rem">${errorIcon}</span>
                        <strong style="font-size:1.1rem">${errorTitle}</strong>
                    </div>
                    <p style="margin:0;padding:12px;background:rgba(220,38,38,0.1);border-radius:8px;color:var(--danger-dark);font-weight:500">
                        ${e.message}
                    </p>
                `;
                document.getElementById('sideResult').innerHTML = 
                    `<p class="text-danger"><strong>${errorIcon} ${errorTitle}</strong><br>${e.message}</p>`;
                
                // Hide overlays
                document.getElementById('attWorkerDetected').style.display = 'none';
                hideAnnotatedFrame(annotatedImage);
                showAttendanceRefreshButton();
            } finally {
                load.classList.remove('show');
                btn.disabled = false;
                recording.style.display = 'none';
            }
        });

        // ===== REGISTRATION =====
        function setRegistrationImage(blob, sourceLabel) {
            regBlob = blob;

            if (regPreviewUrl) {
                URL.revokeObjectURL(regPreviewUrl);
            }

            regPreviewUrl = URL.createObjectURL(blob);
            document.getElementById('regPreviewImg').src = regPreviewUrl;
            document.getElementById('regPreviewSource').textContent = sourceLabel;
            document.getElementById('regPreview').classList.add('show');
            document.getElementById('regFaceDetected').style.display = 'flex';
            document.getElementById('btnRegSubmit').disabled = false;
        }

        function resetRegistrationImage() {
            regBlob = null;

            if (regPreviewUrl) {
                URL.revokeObjectURL(regPreviewUrl);
                regPreviewUrl = null;
            }

            document.getElementById('regPreviewImg').removeAttribute('src');
            document.getElementById('regPreviewSource').textContent = 'Belum ada gambar';
            document.getElementById('regPreview').classList.remove('show');
            document.getElementById('regFaceDetected').style.display = 'none';
            document.getElementById('regUpload').value = '';
            document.getElementById('btnRegCapture').innerHTML = '📸 Capture Wajah';
            document.getElementById('btnRegCapture').classList.remove('btn-success');
        }
        document.getElementById('btnRegCapture').addEventListener('click', async () => {
            const video = document.getElementById('regVideo');
            const capturedBlob = await captureFrame(video);
            setRegistrationImage(capturedBlob, 'Dari kamera');
            document.getElementById('btnRegCapture').innerHTML = '✅ Foto Diambil';
            document.getElementById('btnRegCapture').classList.add('btn-success');
        });

        document.getElementById('regUpload').addEventListener('change', (event) => {
            const file = event.target.files?.[0];
            if (!file) return;

            if (!file.type.startsWith('image/')) {
                alert('File harus berupa gambar.');
                event.target.value = '';
                return;
            }

            setRegistrationImage(file, file.name);
            document.getElementById('btnRegCapture').innerHTML = '📸 Capture Wajah';
            document.getElementById('btnRegCapture').classList.remove('btn-success');
        });

        document.getElementById('btnRegSubmit').addEventListener('click', async () => {
            const name = document.getElementById('workerName').value.trim();
            const dept = document.getElementById('workerDept').value.trim();
            const position = document.getElementById('workerPosition').value.trim();
            const email = document.getElementById('workerEmail').value.trim();
            const phone = document.getElementById('workerPhone').value.trim();
            
            if (!name) return alert('❌ Nama pekerja harus diisi!');
            if (!regBlob) return alert('Ambil foto wajah atau upload gambar dulu!');
            
            const btn = document.getElementById('btnRegSubmit');
            const load = document.getElementById('regLoading');
            const resBox = document.getElementById('regResult');
            
            btn.disabled = true;
            load.classList.add('show');
            resBox.classList.remove('show');
            
            try {
                const data = await post('/register-face', regBlob, { 
                    worker_name: name,
                    department: dept,
                    position: position,
                    email: email,
                    phone: phone
                });
                
                resBox.className = 'result-box accepted show';
                resBox.innerHTML = `
                    <strong>✅ ${data.message}</strong><br><br>
                    <div style="background: rgba(255,255,255,0.7); padding: 12px; border-radius: 8px; margin-top: 12px; font-size: 0.9rem">
                        ${data.worker?.department ? `<div>🏢 Dept: <strong>${data.worker.department}</strong></div>` : ''}
                        ${data.worker?.position ? `<div>💼 Posisi: <strong>${data.worker.position}</strong></div>` : ''}
                        ${data.worker?.email ? `<div>📧 Email: <strong>${data.worker.email}</strong></div>` : ''}
                        ${data.worker?.phone ? `<div>📱 Phone: <strong>${data.worker.phone}</strong></div>` : ''}
                    </div>
                `;
                
                // Reset form
                ['workerName','workerDept','workerPosition','workerEmail','workerPhone'].forEach(id => {
                    document.getElementById(id).value = '';
                });
                btn.disabled = true;
                resetRegistrationImage();
                document.getElementById('btnRegCapture').innerHTML = '📸 Capture Wajah';
                document.getElementById('btnRegCapture').classList.remove('btn-success');
                document.getElementById('regFaceDetected').style.display = 'none';
                
                refreshAppViews(null, { resetInference: false });
                
            } catch (e) {
                resBox.className = 'result-box rejected show';
                resBox.innerHTML = `❌ <strong>Error:</strong> ${e.message}`;
            } finally {
                load.classList.remove('show');
                btn.disabled = !regBlob;
            }
        });

        // ===== MONITORING =====
        let lastWarnedTime = 0; // Track last warning time to avoid continuous beeps
        
        function playBeepSound() {
            try {
                // Create audio context for beep sound
                const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                
                // Play 3 beeps in sequence
                for (let i = 0; i < 3; i++) {
                    const oscillator = audioContext.createOscillator();
                    const gainNode = audioContext.createGain();
                    
                    oscillator.connect(gainNode);
                    gainNode.connect(audioContext.destination);
                    
                    // Beep parameters
                    oscillator.frequency.value = 800; // 800 Hz
                    oscillator.type = 'sine';
                    
                    // Timing: each beep is 0.3s, with 0.1s gap between them
                    const startTime = audioContext.currentTime + (i * 0.4); // 0.3s beep + 0.1s gap
                    
                    // Set volume
                    gainNode.gain.setValueAtTime(0.3, startTime);
                    gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + 0.3);
                    
                    // Play for 0.3 seconds
                    oscillator.start(startTime);
                    oscillator.stop(startTime + 0.3);
                }
            } catch (e) {
                console.warn('Could not play beep sound:', e);
            }
        }
        
        // ===== BROWSER MULTI-CAMERA MONITORING =====
        let monitorStreams = {};
        let monitorDevices = [];
        let monitorCaptureInProgress = false;

        async function unlockCameraLabels() {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                stream.getTracks().forEach(track => track.stop());
            } catch (e) {
                console.warn('Could not unlock camera labels:', e);
            }
        }

        async function getAvailableMonitorCameras() {
            if (!navigator.mediaDevices?.enumerateDevices) return [];

            const mapVideoInputs = (devices) => devices
                .filter(device => device.kind === 'videoinput')
                .map((device, index) => ({
                    index,
                    deviceId: device.deviceId,
                    label: device.label || `Camera ${index + 1}`,
                }));

            let cameras = mapVideoInputs(await navigator.mediaDevices.enumerateDevices());

            if (cameras.length === 0) {
                await unlockCameraLabels();
                cameras = mapVideoInputs(await navigator.mediaDevices.enumerateDevices());
            }

            if (cameras.length === 0) {
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                    stream.getTracks().forEach(track => track.stop());
                    cameras = [{ index: 0, deviceId: 'default', label: 'Default Camera' }];
                } catch (e) {
                    console.warn('Fallback camera probe failed:', e);
                }
            }

            return cameras;
        }

        function cameraKey(index, deviceId) {
            return String(index ?? deviceId ?? '');
        }

        function renderMonitorCards(cameras) {
            const grid = document.getElementById('monCameraGrid');
            if (!grid) return;

            if (!cameras || cameras.length === 0) {
                grid.innerHTML = '<div class="camera-grid__empty">Tidak ada kamera yang terdeteksi. Pastikan izin kamera sudah diberikan.</div>';
                const countEl = document.getElementById('monCameraCount');
                if (countEl) countEl.textContent = '0 kamera';
                return;
            }

            const countEl = document.getElementById('monCameraCount');
            if (countEl) countEl.textContent = `${cameras.length} kamera`;

            grid.innerHTML = cameras.map(camera => {
                const key = cameraKey(camera.index, camera.deviceId);
                return `
                    <div class="camera-card" id="monCard-${key}">
                        <div class="camera-card__preview">
                            <video id="monVideo-${key}" autoplay playsinline muted></video>
                            <img id="monAnnotated-${key}" class="annotation-frame" alt="" style="display:none">
                            <div class="camera-card__placeholder" id="monPlaceholder-${key}">
                                <div style="font-size:1.3rem">📷</div>
                                <div>${camera.label}</div>
                                <div>Menunggu kamera aktif</div>
                            </div>
                        </div>
                        <div class="camera-card__body">
                            <div class="camera-card__header">
                                <div class="camera-card__title">${camera.label}</div>
                                <div class="status-badge status-badge--warn" id="monBadge-${key}">
                                    <span class="status-badge__dot"></span>
                                    <span>Idle</span>
                                </div>
                            </div>
                            <div class="camera-card__meta" id="monMeta-${key}">Belum ada stream</div>
                            <div class="ppe-status-grid" style="grid-template-columns:repeat(3,1fr);gap:6px;margin:0">
                                <div class="ppe-item ok" id="monHelmCard-${key}">🪖 Helm</div>
                                <div class="ppe-item ok" id="monVestCard-${key}">🦺 Rompi</div>
                                <div class="ppe-item ok" id="monBootsCard-${key}">👢 Sepatu</div>
                            </div>
                            <div class="camera-card__warning" id="monWarningCard-${key}" style="display:none"></div>
                        </div>
                    </div>
                `;
            }).join('');
        }

        async function attachMonitorStreams(cameras) {
            for (const camera of cameras) {
                const key = cameraKey(camera.index, camera.deviceId);
                const videoEl = document.getElementById(`monVideo-${key}`);
                const placeholderEl = document.getElementById(`monPlaceholder-${key}`);
                const badgeEl = document.getElementById(`monBadge-${key}`);
                const metaEl = document.getElementById(`monMeta-${key}`);

                if (!videoEl || !badgeEl || !metaEl) continue;

                try {
                    if (monitorStreams[key]) {
                        monitorStreams[key].getTracks().forEach(track => track.stop());
                    }

                    const videoConstraints = {
                        width: { ideal: 1280 },
                        height: { ideal: 720 },
                    };

                    if (camera.deviceId && camera.deviceId !== 'default') {
                        videoConstraints.deviceId = { exact: camera.deviceId };
                    }

                    const stream = await navigator.mediaDevices.getUserMedia({
                        video: videoConstraints,
                        audio: false,
                    });

                    monitorStreams[key] = stream;
                    videoEl.srcObject = stream;
                    badgeEl.className = 'status-badge status-badge--ok';
                    const statusText = badgeEl.querySelector('span:last-child');
                    if (statusText) statusText.textContent = 'Online';
                    if (placeholderEl) placeholderEl.style.display = 'none';
                    metaEl.textContent = `${camera.label} • Stream aktif`;
                } catch (e) {
                    console.warn(`Failed to open camera ${camera.label}:`, e);
                    badgeEl.className = 'status-badge status-badge--danger';
                    const statusText = badgeEl.querySelector('span:last-child');
                    if (statusText) statusText.textContent = 'Offline';
                    if (placeholderEl) {
                        placeholderEl.style.display = 'flex';
                        placeholderEl.innerHTML = `
                            <div style="font-size:1.3rem">📷</div>
                            <div>${camera.label}</div>
                            <div>Gagal membuka kamera</div>
                        `;
                    }
                    metaEl.textContent = 'Kamera tidak bisa diakses';
                }
            }
        }

        function stopMonitorStreams() {
            Object.values(monitorStreams).forEach(stream => {
                try {
                    stream.getTracks().forEach(track => track.stop());
                } catch (e) {
                    console.warn('Failed to stop stream:', e);
                }
            });
            monitorStreams = {};

        }

        function blobToImage(blob) {
            return new Promise((resolve, reject) => {
                const image = new Image();
                const url = URL.createObjectURL(blob);
                image.onload = () => {
                    URL.revokeObjectURL(url);
                    resolve(image);
                };
                image.onerror = error => {
                    URL.revokeObjectURL(url);
                    reject(error);
                };
                image.src = url;
            });
        }

        async function buildAnnotatedFrame(blob, detections) {
            if (typeof drawDetections !== 'function' || typeof canvasToBase64 !== 'function') {
                return null;
            }

            const image = await blobToImage(blob);
            const canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth || image.width;
            canvas.height = image.naturalHeight || image.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
            drawDetections(canvas, detections || []);
            return canvasToBase64(canvas, 0.8);
        }

        function updateMonitorCard(camera, result) {
            const key = cameraKey(camera.index, camera.deviceId);
            const imageEl = document.getElementById(`monAnnotated-${key}`);
            const placeholderEl = document.getElementById(`monPlaceholder-${key}`);
            const badgeEl = document.getElementById(`monBadge-${key}`);
            const metaEl = document.getElementById(`monMeta-${key}`);
            const warningEl = document.getElementById(`monWarningCard-${key}`);
            const videoEl = document.getElementById(`monVideo-${key}`);

            if (!imageEl || !badgeEl || !metaEl) return;

            const helmet = !!result?.ppe_status?.helmet;
            const vest = !!result?.ppe_status?.vest;
            const boots = !!result?.ppe_status?.boots;

            [['monHelmCard', helmet], ['monVestCard', vest], ['monBootsCard', boots]].forEach(([prefix, status]) => {
                const el = document.getElementById(`${prefix}-${key}`);
                if (el) el.className = `ppe-item ${status ? 'ok' : 'missing'}`;
            });

            const statusTextEl = badgeEl.querySelector('span:last-child');
            badgeEl.className = `status-badge ${result?.warning ? 'status-badge--danger' : 'status-badge--ok'}`;
            if (statusTextEl) statusTextEl.textContent = result?.warning ? 'Alert' : 'Online';

            metaEl.textContent = [
                camera.label,
                result?.timestamp ? `Update: ${new Date(result.timestamp).toLocaleTimeString('id-ID')}` : 'Menunggu inference',
            ].join(' • ');

            if (videoEl && videoEl.srcObject && placeholderEl) {
                placeholderEl.style.display = 'none';
            }

            if (result?.annotated_frame) {
                imageEl.src = `data:image/jpeg;base64,${result.annotated_frame}`;
                imageEl.style.display = 'block';
                if (placeholderEl) placeholderEl.style.display = 'none';
            } else {
                imageEl.removeAttribute('src');
                imageEl.style.display = 'none';
                if (placeholderEl) placeholderEl.style.display = 'flex';
            }

            if (warningEl) {
                if (result?.warning) {
                    warningEl.textContent = result.warning;
                    warningEl.style.display = 'block';
                } else {
                    warningEl.style.display = 'none';
                }
            }
        }

        function updateMonitorOverview(running, cameraCount, latestAlert) {
            const connEl = document.getElementById('monConnStatus');
            if (connEl) {
                connEl.textContent = running ? `Running (${cameraCount || 0} kamera)` : 'Ready';
                connEl.className = running ? 'text-success' : 'text-muted';
            }

            const warningEl = document.getElementById('monWarning');
            const warningText = document.getElementById('monWarningText');
            if (warningEl && warningText) {
                warningEl.classList.toggle('show', !!latestAlert?.warning);
                warningText.textContent = latestAlert?.warning || 'Tidak ada peringatan aktif';
            }
        }

        async function loadMonitorPage() {
            stopMonitorPolling();
            stopMonitorStreams();
            seenMonitorEvents.clear();
            lastWarnedTime = 0;
            const grid = document.getElementById('monCameraGrid');
            if (grid) grid.innerHTML = '<div class="camera-grid__empty">Memuat kamera lokal...</div>';

            try {
                monitorDevices = await getAvailableMonitorCameras();
                renderMonitorCards(monitorDevices);
                await attachMonitorStreams(monitorDevices);
                updateMonitorOverview(false, monitorDevices.length, null);
            } catch (e) {
                console.warn('Load monitor page error:', e);
                if (grid) {
                    grid.innerHTML = '<div class="camera-grid__empty">Gagal memuat kamera. Pastikan izin kamera sudah diberikan.</div>';
                }
            }
        }

        async function monitorCycle() {
            if (!monRunning || monitorCaptureInProgress) return;
            monitorCaptureInProgress = true;

            try {
                const cameras = monitorDevices.length ? monitorDevices : await getAvailableMonitorCameras();
                monitorDevices = cameras;

                let latestAlert = null;
                for (const camera of cameras) {
                    if (!monRunning) break;

                    const key = cameraKey(camera.index, camera.deviceId);
                    const videoEl = document.getElementById(`monVideo-${key}`);
                    if (!videoEl || videoEl.videoWidth === 0 || videoEl.videoHeight === 0) continue;

                    try {
                        const blob = await captureFrame(videoEl, false);
                        if (!blob) continue;

                        const fd = new FormData();
                        fd.append('file', blob, 'frame.jpg');
                        fd.append('source_label', camera.label);

                        const res = await fetch(`${API}/monitor/frame`, {
                            method: 'POST',
                            body: fd,
                        });

                        if (!res.ok) throw new Error(`HTTP ${res.status}`);
                        const result = await res.json();
                        result.camera_label = camera.label;
                        result.timestamp = result.timestamp || new Date().toISOString();

                        updateMonitorCard(camera, result);
                        if (result.warning) {
                            latestAlert = {
                                camera_label: camera.label,
                                timestamp: result.timestamp,
                                warning: result.warning,
                            };
                            appendMonitorEvent(latestAlert);
                        }
                    } catch (e) {
                        console.warn(`Monitor inference failed for ${camera.label}:`, e);
                        updateMonitorCard(camera, { warning: '', annotated_frame: null, ppe_status: {} });
                    }
                }

                updateMonitorOverview(true, cameras.length, latestAlert);
            } finally {
                monitorCaptureInProgress = false;
            }
        }

        async function refreshMonitorStatus() {
            if (!monRunning) return;
            try {
                await monitorCycle();
            } finally {
                if (monRunning) {
                    monRefreshTimer = setTimeout(refreshMonitorStatus, MONITOR_REFRESH_MS);
                }
            }
        }

        async function startLocalMonitoring() {
            monRunning = true;
            setMonitorButtons(true);
            const badgeEl = document.getElementById('alertBadge');
            if (badgeEl) badgeEl.style.display = 'none';
            try {
                await loadMonitorPage();
                if (typeof ensureInferenceReady === 'function') {
                    ensureInferenceReady().catch(e => console.warn('Inference warmup skipped:', e));
                }
                await refreshMonitorStatus();
            } catch (e) {
                console.warn('Start local monitoring failed:', e);
                monRunning = false;
                setMonitorButtons(false);
            }
        }

        async function stopLocalMonitoring() {
            monRunning = false;
            stopMonitorPolling();
            stopMonitorStreams();
            setMonitorButtons(false);
            const warningEl = document.getElementById('monWarning');
            if (warningEl) warningEl.classList.remove('show');
        }

        document.getElementById('btnMonStart')?.addEventListener('click', startLocalMonitoring);
        document.getElementById('btnMonStop')?.addEventListener('click', stopLocalMonitoring);
        document.getElementById('btnMonRefresh')?.addEventListener('click', loadMonitorPage);

        // ===== REPORTS =====
        async function loadReport() {
            const btn = document.getElementById('btnGenerateReport');
            const load = document.getElementById('reportLoading');
            
            btn.disabled = true;
            load.classList.add('show');
            
            try {
                const startDate = document.getElementById('reportStartDate')?.value;
                const endDate = document.getElementById('reportEndDate')?.value;
                const dateParams = startDate && endDate
                    ? `?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`
                    : '';
                const data = await get(`/reports/compliance${dateParams}`);
                
                // Summary stats
                const total = data.report?.reduce((sum, r) => sum + (r.total || 0), 0) || 0;
                const accepted = data.report?.reduce((sum, r) => sum + (r.accepted || 0), 0) || 0;
                const rejected = data.report?.reduce((sum, r) => sum + (r.rejected || 0), 0) || 0;
                const compliance = total > 0 ? Math.round((accepted / total) * 100) : 0;
                
                document.getElementById('rptTotal').textContent = total;
                document.getElementById('rptAccepted').textContent = accepted;
                document.getElementById('rptRejected').textContent = rejected;
                document.getElementById('rptCompliance').textContent = `${compliance}%`;
                
                // PPE compliance
                const avgHelm = data.report?.reduce((sum, r) => sum + (r.helmet_pct || 0), 0) / (data.report?.length || 1);
                const avgVest = data.report?.reduce((sum, r) => sum + (r.vest_pct || 0), 0) / (data.report?.length || 1);
                const avgBoots = data.report?.reduce((sum, r) => sum + (r.boots_pct || 0), 0) / (data.report?.length || 1);
                
                document.getElementById('rptHelm').textContent = `${Math.round(avgHelm || 0)}%`;
                document.getElementById('rptVest').textContent = `${Math.round(avgVest || 0)}%`;
                document.getElementById('rptBoots').textContent = `${Math.round(avgBoots || 0)}%`;
                
                // Table
                const tbody = document.getElementById('reportTableBody');
                if (data.report?.length) {
                    tbody.innerHTML = data.report.map(r => `
                        <tr>
                            <td class="fw-600">${r.name}</td>
                            <td>${r.accepted || 0}</td>
                            <td>${r.rejected || 0}</td>
                            <td>${r.total || 0}</td>
                            <td>${Math.round(r.helmet_pct || 0)}%</td>
                            <td>${Math.round(r.vest_pct || 0)}%</td>
                            <td>${Math.round(r.boots_pct || 0)}%</td>
                        </tr>
                    `).join('');
                } else {
                    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted" style="padding:24px">📊 Tidak ada data untuk periode ini</td></tr>';
                }
                
            } catch (e) {
                console.error('Report error:', e);
                alert('❌ Gagal generate laporan: ' + e.message);
            } finally {
                btn.disabled = false;
                load.classList.remove('show');
            }
        }

        document.getElementById('btnGenerateReport').addEventListener('click', loadReport);

        // ===== SEARCH HISTORY =====
        document.getElementById('historySearch')?.addEventListener('input', (e) => {
            const term = e.target.value.toLowerCase();
            const rows = document.querySelectorAll('#historyTableBody tr');
            
            rows.forEach(row => {
                const text = row.textContent.toLowerCase();
                row.style.display = text.includes(term) ? '' : 'none';
            });
        });

        // ===== INIT =====
        document.addEventListener('DOMContentLoaded', () => {
            // Load initial data
            loadDashboardStats();
            loadLatestAttendance();
            
            // Auto-init camera for first visible camera page
            initCamera('attendance');
            
            console.log('🛡️ K3Vision Dashboard v2.0 loaded');
        });

        // ===== CLEANUP =====
        window.addEventListener('beforeunload', () => {
            Object.values(streams).forEach(stream => {
                stream.getTracks().forEach(track => track.stop());
            });
            monAbort?.abort();
        });
    
