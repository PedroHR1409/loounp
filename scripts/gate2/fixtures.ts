export const fixtureFiles: Record<string, string> = {
  'orders-api/README.md': '# Orders API\n\nService that receives orders, charges customers and notifies shipping.\n',
  'orders-api/src/payments.py': `from src.transport.policy import post_with_policy

PROVIDER_URL = "https://payments.example/charge"


def charge_customer(order):
    """Charge the customer through the payment provider.

    The downstream provider is flaky: timeouts and repeated failures happen at peak hours.
    """
    payload = {"amount": order["total"], "customer": order["customer_id"]}
    return post_with_policy(PROVIDER_URL, payload)
`,
  'orders-api/src/transport/policy.py': `import time
import urllib.request


def post_with_policy(url, payload, attempts=3):
    last_error = None
    for attempt in range(attempts):
        try:
            return _send(url, payload)
        except OSError as error:
            last_error = error
            time.sleep(2 ** attempt)
    raise last_error


def _send(url, payload):
    request = urllib.request.Request(url, data=repr(payload).encode())
    return urllib.request.urlopen(request, timeout=5).read()
`,
  'orders-api/src/shipping.py': `def notify_shipping(order):
    return {"order": order["id"], "status": "ready"}
`,
  'orders-api/src/models.py': `from dataclasses import dataclass


@dataclass
class Order:
    id: str
    customer_id: str
    total: float
`,
  'notes-rag/README.md': '# Notes RAG\n\nAsk questions about personal notes.\n',
  'notes-rag/src/pipeline.py': `from src.encoder import encode_batch
from src.store import nearest


def answer_question(question, notes):
    """Retrieval augmented generation over notes: embeds the question and the documents on every request."""
    vectors = encode_batch([question] + [note["text"] for note in notes])
    return nearest(vectors[0], vectors[1:], notes)
`,
  'notes-rag/src/encoder.py': `ENCODER_ID = "text-small"


def encode_batch(texts):
    return [_encode(text) for text in texts]


def _encode(text):
    return [float(ord(char)) for char in text[:16]]
`,
  'notes-rag/src/store.py': `def nearest(query, candidates, notes):
    scores = [sum(a * b for a, b in zip(query, candidate)) for candidate in candidates]
    return notes[scores.index(max(scores))] if scores else None
`,
  'notes-rag/src/cli.py': `import sys


def main():
    print(" ".join(sys.argv[1:]))
`,
  'etl-jobs/README.md': '# ETL jobs\n\nNightly jobs that load partner files into the warehouse.\n',
  'etl-jobs/src/ingest.py': `from src.readers.rows import parse_rows
from src.warehouse import load


def ingest_file(path):
    """Ingestion of partner CSV files into the warehouse. Partners change columns and files often break."""
    rows = parse_rows(path)
    load(rows)
    return len(rows)
`,
  'etl-jobs/src/readers/rows.py': `def parse_rows(path):
    with open(path, encoding="utf-8") as handle:
        header = handle.readline().strip().split(",")
        return [dict(zip(header, line.strip().split(","))) for line in handle]
`,
  'etl-jobs/src/warehouse.py': `def load(rows):
    return len(rows)
`,
  'landing-site/README.md': '# Landing site\n\nStatic marketing page.\n',
  'landing-site/src/build.py': `def render(title):
    return f"<h1>{title}</h1>"
`,
}
