from fastapi import FastAPI

app = FastAPI(title="osumaps backend")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}

