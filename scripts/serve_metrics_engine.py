"""Run only the P6 metrics/fundamentals/history/quotes endpoints (offline=True skips the universe warm-up)."""
import uvicorn
from engine.app import create_app

if __name__ == "__main__":
    uvicorn.run(create_app(offline=True), host="127.0.0.1", port=8001, log_level="warning")
