import os
import sys
import time
import json
import logging
from pathlib import Path
from datetime import datetime, timezone

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s UTC | %(levelname)s | %(message)s",
)

SOURCE_URL = os.getenv("SOURCE_URL", "").strip()
TARGET_URL = os.getenv("TARGET_URL", "").strip()
SYNC_TOKEN = os.getenv("SYNC_TOKEN", "").strip()

TIMEOUT = int(os.getenv("SYNC_TIMEOUT", "30"))
MAX_ATTEMPTS = int(os.getenv("SYNC_ATTEMPTS", "5"))


def required_env():
    missing = []

    if not SOURCE_URL:
        missing.append("SOURCE_URL")

    if not TARGET_URL:
        missing.append("TARGET_URL")

    if not SYNC_TOKEN:
        missing.append("SYNC_TOKEN")

    if missing:
        raise RuntimeError(
            "Missing required GitHub Secrets: " + ", ".join(missing)
        )


def create_session():
    retry = Retry(
        total=MAX_ATTEMPTS,
        connect=MAX_ATTEMPTS,
        read=MAX_ATTEMPTS,
        backoff_factor=2,
        status_forcelist=[408, 425, 429, 500, 502, 503, 504],
        allowed_methods=["GET", "POST", "PUT", "PATCH"],
        respect_retry_after_header=True,
        raise_on_status=False,
    )

    adapter = HTTPAdapter(
        max_retries=retry,
        pool_connections=10,
        pool_maxsize=10,
    )

    session = requests.Session()
    session.mount("https://", adapter)
    session.mount("http://", adapter)

    session.headers.update({
        "Authorization": f"Bearer {SYNC_TOKEN}",
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "daily-auto-sync/1.0",
    })

    return session


def fetch_source(session):
    logging.info("Fetching source data")

    response = session.get(
        SOURCE_URL,
        timeout=TIMEOUT,
    )

    response.raise_for_status()

    if not response.content:
        raise RuntimeError("Source returned empty response")

    try:
        return response.json()
    except ValueError as error:
        raise RuntimeError("Source did not return valid JSON") from error


def send_to_target(session, payload):
    logging.info("Sending data to target")

    body = {
        "data": payload,
        "synced_at": datetime.now(timezone.utc).isoformat(),
        "source": "github-actions",
    }

    response = session.post(
        TARGET_URL,
        json=body,
        timeout=TIMEOUT,
    )

    response.raise_for_status()

    if response.status_code not in [200, 201, 202, 204]:
        raise RuntimeError(
            f"Unexpected target status: {response.status_code}"
        )

    logging.info("Target accepted sync: HTTP %s", response.status_code)


def write_backup(payload):
    backup_dir = Path("sync-backups")
    backup_dir.mkdir(exist_ok=True)

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    backup_file = backup_dir / f"sync-{timestamp}.json"

    backup_file.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    logging.info("Backup created: %s", backup_file)


def main():
    required_env()

    session = create_session()
    payload = fetch_source(session)

    write_backup(payload)
    send_to_target(session, payload)

    logging.info("SYNC_SUCCESS")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        logging.exception("SYNC_FAILED: %s", error)
        sys.exit(1)
