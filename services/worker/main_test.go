package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHealthEndpoint(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	newRouter().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "ragchat-go-worker") {
		t.Fatalf("unexpected health body: %s", rec.Body.String())
	}
}

func TestProcessBatchPiiAndHash(t *testing.T) {
	payload := ProcessRequest{
		ChunkSize:          120,
		ChunkOverlap:       20,
		EnablePiiRedaction: true,
		Documents: []ProcessDocInput{
			{
				Filename: "policy.md",
				Page:     2,
				Content:  "# Auth Guide\nContact alice@example.com or 555-234-5678 for OAuth configuration details.",
			},
			{
				Filename: "notes.txt",
				Content:  "Zero secrets here. Just architecture notes about Qdrant and Redis.",
			},
		},
	}

	body, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/v1/process", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	newRouter().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var resp ProcessResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if len(resp.Results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(resp.Results))
	}
	if resp.Results[0].Redactions < 2 {
		t.Fatalf("expected at least 2 PII redactions, got %d", resp.Results[0].Redactions)
	}
	if len(resp.Results[0].Hash) != 64 {
		t.Fatalf("expected 64-char sha256 hash, got %s", resp.Results[0].Hash)
	}
	if len(resp.Results[0].Chunks) == 0 || !strings.Contains(resp.Results[0].Chunks[0].PageContent, "[REDACTED_EMAIL]") {
		t.Fatalf("expected redacted chunk header, got %+v", resp.Results[0].Chunks)
	}
}

func TestBM25ScoringOrder(t *testing.T) {
	payload := BM25Request{
		Query: "postgresql read only transaction",
		Limit: 2,
		Documents: []BM25Doc{
			{ID: "doc-a", Content: "Baking recipes with flour and sugar"},
			{ID: "doc-b", Content: "PostgreSQL read only transaction isolation and connection pooling"},
			{ID: "doc-c", Content: "PostgreSQL backups"},
		},
	}

	body, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/v1/bm25", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	newRouter().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var resp BM25Response
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if len(resp.Hits) != 2 || resp.Hits[0].ID != "doc-b" {
		t.Fatalf("expected doc-b first, got %+v", resp.Hits)
	}
}
