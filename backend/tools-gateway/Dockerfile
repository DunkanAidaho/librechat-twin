FROM python:3.11-slim
WORKDIR /app

COPY requirements.txt .
RUN apt-get update && apt-get install -y --no-install-recommends wget && \
    pip install --no-cache-dir -r requirements.txt google-cloud-aiplatform

COPY . /app
ENV PYTHONPATH=/app

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
