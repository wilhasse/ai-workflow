FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create data directory for state files
RUN mkdir -p /app/data /app/logs

# Expose API port
EXPOSE 5002

# Set environment variables
ENV PYTHONUNBUFFERED=1 \
    PORT=5002 \
    HOST=0.0.0.0

# Health check
HEALTHCHECK --interval=30s --timeout=3s --retries=3 --start-period=10s \
    CMD curl -f http://localhost:5002/health || exit 1

# Run the daemon
CMD ["python", "-m", "src.daemon"]
