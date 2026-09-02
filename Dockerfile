FROM python:3.11-slim

# ffmpeg pour la conversion audio et fusion vidéo
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && \
    pip install --no-cache-dir --upgrade yt-dlp

COPY . .

# Dossier de téléchargements persistant
RUN mkdir -p downloads

EXPOSE 8080

CMD ["python3", "app.py"]
