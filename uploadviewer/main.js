<script>
// Global variables
let currentAnimation = {
    frames: [],
    currentFrame: 0,
    totalFrames: 0,
    isPlaying: false,
    speed: 200, // ms per frame
    intervalId: null
};

let characterParts = {
    head: { visible: true, image: null },
    body: { visible: true, image: null },
    hat: { visible: true, image: null },
    accessory: { visible: true, image: null },
    shield: { visible: true, image: null },
    sword: { visible: true, image: null }
};

let currentDirection = 2; // Down (0: Up, 1: Left, 2: Down, 3: Right)
let zoomLevel = 1;
let currentBackground = 'checkerboard';
let autoWalkEnabled = false;
let multiViewVisible = true;

document.addEventListener('DOMContentLoaded', function() {
    // Canvas setup
    const mainCanvas = document.getElementById('preview-canvas');
    const ctx = mainCanvas.getContext('2d');
    
    // Multi-view canvases
    const viewCanvases = {
        up: document.getElementById('view-up'),
        down: document.getElementById('view-down'),
        left: document.getElementById('view-left'),
        right: document.getElementById('view-right')
    };
    
    // Initialize canvas with default background
    drawCheckerboard(ctx, mainCanvas.width, mainCanvas.height);
    
    // Set up event listeners for UI controls
    setupEventListeners();
    
    // Load default assets and setup
    initializeViewer();
    
    function setupEventListeners() {
        // File upload
        const fileInput = document.getElementById('file-upload');
        const dropZone = document.getElementById('drop-zone');
        
        fileInput.addEventListener('change', handleFileUpload);
        
        // Drag and drop functionality
        dropZone.addEventListener('dragover', function(e) {
            e.preventDefault();
            dropZone.classList.add('active');
        });
        
        dropZone.addEventListener('dragleave', function() {
            dropZone.classList.remove('active');
        });
        
        dropZone.addEventListener('drop', function(e) {
            e.preventDefault();
            dropZone.classList.remove('active');
            handleDroppedFiles(e.dataTransfer.files);
        });
        
        // Animation controls
        document.getElementById('play-btn').addEventListener('click', playAnimation);
        document.getElementById('pause-btn').addEventListener('click', pauseAnimation);
        document.getElementById('reset-btn').addEventListener('click', resetAnimation);
        document.getElementById('export-btn').addEventListener('click', exportPreview);
        
        // Direction and view controls
        document.getElementById('direction-select').addEventListener('change', function(e) {
            changeDirection(parseInt(e.target.value));
        });
        
        document.getElementById('toggle-views').addEventListener('click', toggleMultiView);
        document.getElementById('auto-walk').addEventListener('click', toggleAutoWalk);
        
        // Zoom control
        document.getElementById('zoom-select').addEventListener('change', function(e) {
            zoomLevel = parseInt(e.target.value);
            renderFrame();
        });
        
        // Part visibility toggles
        document.getElementById('toggle-head').addEventListener('change', function(e) {
            characterParts.head.visible = e.target.checked;
            renderFrame();
        });
        
        document.getElementById('toggle-body').addEventListener('change', function(e) {
            characterParts.body.visible = e.target.checked;
            renderFrame();
        });
        
        document.getElementById('toggle-hat').addEventListener('change', function(e) {
            characterParts.hat.visible = e.target.checked;
            renderFrame();
        });
        
        document.getElementById('toggle-accessory').addEventListener('change', function(e) {
            characterParts.accessory.visible = e.target.checked;
            renderFrame();
        });
        
        document.getElementById('toggle-shield').addEventListener('change', function(e) {
            characterParts.shield.visible = e.target.checked;
            renderFrame();
        });
        
        document.getElementById('toggle-sword').addEventListener('change', function(e) {
            characterParts.sword.visible = e.target.checked;
            renderFrame();
        });
        
        // Background selection
        const bgOptions = document.querySelectorAll('.bg-option');
        bgOptions.forEach(option => {
            option.addEventListener('click', function() {
                bgOptions.forEach(opt => opt.classList.remove('active'));
                this.classList.add('active');
                currentBackground = this.dataset.bg;
                renderFrame();
            });
        });
        
        // Mobile swipe controls
        const swipeButtons = document.querySelectorAll('.swipe-btn');
        swipeButtons.forEach(btn => {
            btn.addEventListener('touchstart', function(e) {
                e.preventDefault();
                if (this.dataset.dir) {
                    changeDirectionMobile(this.dataset.dir);
                }
            });
            
            // Also add click for desktop testing
            btn.addEventListener('click', function() {
                if (this.dataset.dir) {
                    changeDirectionMobile(this.dataset.dir);
                }
            });
        });
        
        // Animation selection
        document.getElementById('animation-select').addEventListener('change', function(e) {
            loadAnimation(e.target.value);
        });
    }
    
    function initializeViewer() {
        // Create default frames for animation
        createDefaultFrames();
        
        // Set initial animation
        loadAnimation('default.gani');
        
        // Update UI
        document.getElementById('status-info').textContent = 'Default character loaded';
        document.getElementById('frame-info').textContent = `Frame: 1/${currentAnimation.totalFrames}`;
        
        // Render initial frame
        renderFrame();
        updateMultiView();
    }
    
    function createDefaultFrames() {
        // Create some simple placeholder frames for demonstration
        for (let i = 0; i < 4; i++) {
            const frame = document.createElement('canvas');
            frame.width = 64;
            frame.height = 64;
            const frameCtx = frame.getContext('2d');
            
            // Draw a simple character for each frame
            frameCtx.fillStyle = '#4F46E5'; // Body color
            frameCtx.fillRect(20, 30, 24, 34); // Body
            
            frameCtx.fillStyle = '#FCD34D'; // Head color
            frameCtx.fillRect(22, 10, 20, 20); // Head
            
            // Add some variation between frames for animation effect
            if (i % 2 === 0) {
                frameCtx.fillStyle = '#EF4444'; // Alternate color for animation
                frameCtx.fillRect(50, 15, 8, 8); // Simple accessory
            }
            
            currentAnimation.frames.push(frame);
        }
        
        currentAnimation.totalFrames = currentAnimation.frames.length;
    }
    
    function handleFileUpload(e) {
        const files = e.target.files;
        processUploadedFiles(files);
    }
    
    function handleDroppedFiles(files) {
        processUploadedFiles(files);
    }
    
    function processUploadedFiles(files) {
        if (files.length > 0) {
            // Show loading state
            document.getElementById('status-info').textContent = 'Processing files...';
            document.getElementById('status-info').classList.add('loading');
            
            // Process each file
            Array.from(files).forEach(file => {
                const reader = new FileReader();
                const fileType = file.name.split('.').pop().toLowerCase();
                
                reader.onload = function(e) {
                    if (fileType === 'png') {
                        // Handle PNG image (character part)
                        processImageFile(file, e.target.result);
                    } else if (fileType === 'gif') {
                        // Handle GIF animation
                        processGifFile(file, e.target.result);
                    } else if (fileType === 'gani') {
                        // Handle GANI animation file
                        processGaniFile(file, e.target.result);
                    }
                    
                    document.getElementById('status-info').classList.remove('loading');
                    document.getElementById('status-info').textContent = 'Files processed successfully';
                    
                    // Show warning for non-standard sizes
                    if (file.type.includes('image')) {
                        const img = new Image();
                        img.onload = function() {
                            if (img.width !== 64 && img.width !== 128 && img.height !== 64 && img.height !== 128) {
                                document.getElementById('size-warning').style.display = 'flex';
                            }
                        };
                        img.src = e.target.result;
                    }
                };
                
                reader.readAsDataURL(file);
            });
        }
    }
    
    function processImageFile(file, dataUrl) {
        // Determine what type of part this is based on filename patterns
        const name = file.name.toLowerCase();
        
        if (name.includes('head') || name.includes('face')) {
            loadImageToPart(dataUrl, 'head');
        } else if (name.includes('body')) {
            loadImageToPart(dataUrl, 'body');
        } else if (name.includes('hat') || name.includes('helm')) {
            loadImageToPart(dataUrl, 'hat');
        } else if (name.includes('accessory') || name.includes('acc')) {
            loadImageToPart(dataUrl, 'accessory');
        } else if (name.includes('shield')) {
            loadImageToPart(dataUrl, 'shield');
        } else if (name.includes('sword') || name.includes('weapon')) {
            loadImageToPart(dataUrl, 'sword');
        } else {
            // Default to body if we can't determine
            loadImageToPart(dataUrl, 'body');
        }
        
        renderFrame();
    }
    
    function loadImageToPart(dataUrl, partName) {
        const img = new Image();
        img.onload = function() {
            characterParts[partName].image = img;
            renderFrame();
        };
        img.src = dataUrl;
    }
    
    function processGifFile(file, dataUrl) {
        // For a real implementation, you would use a GIF parsing library
        // This is a simplified version for demonstration
        
        document.getElementById('status-info').textContent = 'GIF processing not fully implemented in demo';
        
        // Create a simple animation from the GIF
        const img = new Image();
        img.onload = function() {
            // For demo purposes, we'll just use a single frame
            currentAnimation.frames = [img];
            currentAnimation.totalFrames = 1;
            currentAnimation.currentFrame = 0;
            
            document.getElementById('frame-info').textContent = `Frame: 1/1`;
            renderFrame();
        };
        img.src = dataUrl;
    }
    
    function processGaniFile(file, dataUrl) {
        // GANI is a custom format, so we would need to parse it properly
        // This is a simplified placeholder implementation
        
        document.getElementById('status-info').textContent = 'GANI processing not fully implemented in demo';
        
        // Reset and create some frames for demonstration
        currentAnimation.frames = [];
        createDefaultFrames();
        currentAnimation.currentFrame = 0;
        
        document.getElementById('frame-info').textContent = `Frame: 1/${currentAnimation.totalFrames}`;
        renderFrame();
    }
    
    function loadAnimation(animationName) {
        // Reset current animation
        pauseAnimation();
        currentAnimation.currentFrame = 0;
        
        // In a real implementation, this would load the actual animation
        // For demo, we'll use our default frames
        document.getElementById('status-info').textContent = `Loaded animation: ${animationName}`;
        document.getElementById('frame-info').textContent = `Frame: 1/${currentAnimation.totalFrames}`;
        
        renderFrame();
    }
    
    function playAnimation() {
        if (currentAnimation.isPlaying) return;
        
        currentAnimation.isPlaying = true;
        document.getElementById('status-info').textContent = 'Playing animation';
        
        currentAnimation.intervalId = setInterval(() => {
            currentAnimation.currentFrame = (currentAnimation.currentFrame + 1) % currentAnimation.totalFrames;
            document.getElementById('frame-info').textContent = `Frame: ${currentAnimation.currentFrame + 1}/${currentAnimation.totalFrames}`;
            renderFrame();
        }, currentAnimation.speed);
    }
    
    function pauseAnimation() {
        if (!currentAnimation.isPlaying) return;
        
        currentAnimation.isPlaying = false;
        clearInterval(currentAnimation.intervalId);
        document.getElementById('status-info').textContent = 'Animation paused';
    }
    
    function resetAnimation() {
        pauseAnimation();
        currentAnimation.currentFrame = 0;
        document.getElementById('status-info').textContent = 'Animation reset';
        document.getElementById('frame-info').textContent = `Frame: 1/${currentAnimation.totalFrames}`;
        renderFrame();
    }
    
    function exportPreview() {
        // Get the main canvas
        const canvas = document.getElementById('preview-canvas');
        
        // Create a temporary link for downloading
        const link = document.createElement('a');
        link.download = 'graal-custom-preview.png';
        link.href = canvas.toDataURL('image/png');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        document.getElementById('status-info').textContent = 'Preview exported successfully!';
    }
    
    function changeDirection(direction) {
        currentDirection = direction;
        document.getElementById('status-info').textContent = `Direction: ${getDirectionName(direction)}`;
        renderFrame();
        updateMultiView();
    }
    
    function changeDirectionMobile(dir) {
        document.getElementById('direction-select').value = dir;
        changeDirection(parseInt(dir));
    }
    
    function getDirectionName(dir) {
        const directions = ['Up', 'Left', 'Down', 'Right'];
        return directions[dir] || 'Unknown';
    }
    
    function toggleMultiView() {
        const multiView = document.querySelector('.multi-view');
        if (multiView.style.display === 'none') {
            multiView.style.display = 'grid';
            document.getElementById('toggle-views').textContent = 'Toggle Single View';
            multiViewVisible = true;
        } else {
            multiView.style.display = 'none';
            document.getElementById('toggle-views').textContent = 'Toggle Multi View';
            multiViewVisible = false;
        }
    }
    
    function toggleAutoWalk() {
        if (autoWalkEnabled) {
            autoWalkEnabled = false;
            document.getElementById('status-info').textContent = 'Auto-walk stopped';
            document.getElementById('auto-walk').textContent = 'Auto Walk Preview';
        } else {
            autoWalkEnabled = true;
            document.getElementById('status-info').textContent = 'Auto-walk enabled';
            document.getElementById('auto-walk').textContent = 'Stop Auto Walk';
            startAutoWalk();
        }
    }
    
    function startAutoWalk() {
        if (!autoWalkEnabled) return;
        
        // Cycle through directions
        const directions = [0, 1, 2, 3]; // Up, Left, Down, Right
        let dirIndex = 0;
        
        const walkInterval = setInterval(() => {
            if (!autoWalkEnabled) {
                clearInterval(walkInterval);
                return;
            }
            
            changeDirection(directions[dirIndex]);
            dirIndex = (dirIndex + 1) % directions.length;
        }, 1000); // Change direction every second
    }
    
    function renderFrame() {
        const canvas = document.getElementById('preview-canvas');
        const ctx = canvas.getContext('2d');
        
        // Clear canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        // Draw background
        drawBackground(ctx, canvas.width, canvas.height);
        
        // Draw the current animation frame if available
        if (currentAnimation.frames.length > 0) {
            const frame = currentAnimation.frames[currentAnimation.currentFrame];
            
            // Calculate centered position
            const x = (canvas.width - frame.width * zoomLevel) / 2;
            const y = (canvas.height - frame.height * zoomLevel) / 2;
            
            // Draw the frame with zoom
            ctx.drawImage(
                frame, 
                0, 0, frame.width, frame.height,
                x, y, frame.width * zoomLevel, frame.height * zoomLevel
            );
        }
        
        // Draw character parts if they have images
        for (const part in characterParts) {
            if (characterParts[part].visible && characterParts[part].image) {
                const img = characterParts[part].image;
                
                // Calculate centered position
                const x = (canvas.width - img.width * zoomLevel) / 2;
                const y = (canvas.height - img.height * zoomLevel) / 2;
                
                // Draw the part with zoom
                ctx.drawImage(
                    img, 
                    0, 0, img.width, img.height,
                    x, y, img.width * zoomLevel, img.height * zoomLevel
                );
            }
        }
    }
    
    function drawBackground(ctx, width, height) {
        switch(currentBackground) {
            case 'white':
                ctx.fillStyle = 'white';
                ctx.fillRect(0, 0, width, height);
                break;
            case 'black':
                ctx.fillStyle = 'black';
                ctx.fillRect(0, 0, width, height);
                break;
            case 'transparent':
                // Transparent is already handled by clearRect
                break;
            case 'checkerboard':
                drawCheckerboard(ctx, width, height);
                break;
            case 'grass':
                ctx.fillStyle = '#48BB78';
                ctx.fillRect(0, 0, width, height);
                break;
            case 'water':
                ctx.fillStyle = '#3B82F6';
                ctx.fillRect(0, 0, width, height);
                break;
            case 'cave':
                ctx.fillStyle = '#4B5563';
                ctx.fillRect(0, 0, width, height);
                break;
        }
    }
    
    function drawCheckerboard(ctx, width, height) {
        const size = 20;
        for (let x = 0; x < width; x += size) {
            for (let y = 0; y < height; y += size) {
                const isEvenRow = Math.floor(y / size) % 2 === 0;
                const isEvenCol = Math.floor(x / size) % 2 === 0;
                
                if ((isEvenRow && isEvenCol) || (!isEvenRow && !isEvenCol)) {
                    ctx.fillStyle = '#E5E7EB';
                } else {
                    ctx.fillStyle = '#D1D5DB';
                }
                
                ctx.fillRect(x, y, size, size);
            }
        }
    }
    
    function updateMultiView() {
        // Update all multi-view canvases
        for (const [direction, canvas] of Object.entries(viewCanvases)) {
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            
            // Draw a simple representation for each direction
            ctx.fillStyle = '#4F46E5';
            ctx.fillRect(10, 10, 44, 44);
            
            // Draw a head
            ctx.fillStyle = '#FCD34D';
            ctx.fillRect(12, 0, 40, 40);
            
            // Highlight the active direction
            if ((direction === 'up' && currentDirection === 0) ||
                (direction === 'left' && currentDirection === 1) ||
                (direction === 'down' && currentDirection === 2) ||
                (direction === 'right' && currentDirection === 3)) {
                ctx.strokeStyle = '#10B981';
                ctx.lineWidth = 3;
                ctx.strokeRect(5, 5, 54, 54);
            }
        }
    }
});
</script>