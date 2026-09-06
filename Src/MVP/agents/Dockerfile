# Python slim image
FROM python:3.14-slim

WORKDIR /app

# Install make for potential system dependencies (optional)
RUN apk update \
    && apk add --no-cache make

# Copy dependency management files and source code
COPY pyproject.toml ./
COPY src ./src

RUN pip install --no-cache-dir --upgrade pip setuptools wheel

# Install project dependencies
RUN pip install --no-cache-dir -e ".[dev]"

# Copy prompt templates
COPY prompts ./prompts

# Expose internal port
EXPOSE 8000

# Configure ENTRYPOINT for FastAPI via Uvicorn (points to src/main.py)
ENTRYPOINT ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000"]