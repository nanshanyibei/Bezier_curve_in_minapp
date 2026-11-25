FROM python:3.11-slim

WORKDIR /app
COPY app.py .

ENV PORT=80
EXPOSE 80

CMD ["python", "-u", "app.py"]
