package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

type ProcessDocInput struct {
	Filename string `json:"filename"`
	Content  string `json:"content"`
	Page     int    `json:"page,omitempty"`
	Section  string `json:"section,omitempty"`
}

type ProcessRequest struct {
	Documents          []ProcessDocInput `json:"documents"`
	ChunkSize          int               `json:"chunkSize,omitempty"`
	ChunkOverlap       int               `json:"chunkOverlap,omitempty"`
	EnablePiiRedaction bool              `json:"enablePiiRedaction,omitempty"`
}

type ChunkOutput struct {
	PageContent string `json:"pageContent"`
	ChunkIndex  int    `json:"chunkIndex"`
	Page        int    `json:"page"`
	Section     string `json:"section"`
}

type ProcessDocResult struct {
	Filename   string        `json:"filename"`
	Hash       string        `json:"hash"`
	Redactions int           `json:"redactions"`
	Chunks     []ChunkOutput `json:"chunks"`
}

type ProcessResponse struct {
	Results []ProcessDocResult `json:"results"`
}

type BM25Doc struct {
	ID      string `json:"id"`
	Content string `json:"content"`
}

type BM25Request struct {
	Query     string    `json:"query"`
	Documents []BM25Doc `json:"documents"`
	Limit     int       `json:"limit,omitempty"`
}

type BM25Hit struct {
	ID    string  `json:"id"`
	Score float64 `json:"score"`
}

type BM25Response struct {
	Hits []BM25Hit `json:"hits"`
}

var (
	emailRe    = regexp.MustCompile(`[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}`)
	phoneRe    = regexp.MustCompile(`\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b`)
	ssnRe      = regexp.MustCompile(`\b\d{3}-\d{2}-\d{4}\b`)
	ccRe       = regexp.MustCompile(`\b(?:\d{4}[-\s]?){3}\d{4}\b`)
	headingRe  = regexp.MustCompile(`(?m)^#{1,4}\s+(.+)$`)
	tokenRe    = regexp.MustCompile(`[a-z0-9_-]+`)
	stopTokens = map[string]bool{
		"a": true, "an": true, "and": true, "are": true, "as": true, "at": true,
		"be": true, "by": true, "for": true, "from": true, "has": true, "in": true,
		"is": true, "it": true, "of": true, "on": true, "or": true, "that": true,
		"the": true, "to": true, "was": true, "were": true, "with": true, "not": true,
	}
)

func redactPII(text string) (string, int) {
	count := 0
	replaceCount := func(re *regexp.Regexp, mask string, s string) string {
		matches := re.FindAllStringIndex(s, -1)
		count += len(matches)
		return re.ReplaceAllString(s, mask)
	}
	out := replaceCount(emailRe, "[REDACTED_EMAIL]", text)
	out = replaceCount(ssnRe, "[REDACTED_SSN]", out)
	out = replaceCount(ccRe, "[REDACTED_CARD]", out)
	out = replaceCount(phoneRe, "[REDACTED_PHONE]", out)
	return out, count
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func splitChunks(text, filename string, page int, fallbackSection string, chunkSize, overlap int) []ChunkOutput {
	if chunkSize <= 0 {
		chunkSize = 1000
	}
	if overlap < 0 || overlap >= chunkSize {
		overlap = 200
	}
	if page <= 0 {
		page = 1
	}

	section := strings.TrimSpace(fallbackSection)
	if section == "" {
		if m := headingRe.FindStringSubmatch(text); len(m) > 1 {
			section = strings.TrimSpace(m[1])
		}
	}
	if section == "" {
		section = "General"
	}

	cleaned := strings.TrimSpace(text)
	if cleaned == "" {
		return nil
	}

	runes := []rune(cleaned)
	var chunks []ChunkOutput
	step := chunkSize - overlap
	if step <= 0 {
		step = chunkSize
	}

	idx := 0
	for start := 0; start < len(runes); start += step {
		end := start + chunkSize
		if end > len(runes) {
			end = len(runes)
		}
		piece := strings.TrimSpace(string(runes[start:end]))
		if piece != "" {
			if m := headingRe.FindAllStringSubmatch(piece, -1); len(m) > 0 {
				section = strings.TrimSpace(m[len(m)-1][1])
			}
			header := fmt.Sprintf("[Document: %s | Page: %d | Section: %s]", filename, page, section)
			chunks = append(chunks, ChunkOutput{
				PageContent: fmt.Sprintf("%s\n%s", header, piece),
				ChunkIndex:  idx,
				Page:        page,
				Section:     section,
			})
			idx++
		}
		if end == len(runes) {
			break
		}
	}
	return chunks
}

func processBatch(req ProcessRequest) ProcessResponse {
	n := len(req.Documents)
	results := make([]ProcessDocResult, n)
	if n == 0 {
		return ProcessResponse{Results: results}
	}

	workers := runtime.NumCPU()
	if workers > 8 {
		workers = 8
	}
	if workers < 1 {
		workers = 1
	}

	sem := make(chan struct{}, workers)
	var wg sync.WaitGroup

	for i, doc := range req.Documents {
		wg.Add(1)
		go func(idx int, d ProcessDocInput) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			content := d.Content
			redactions := 0
			if req.EnablePiiRedaction {
				content, redactions = redactPII(content)
			}
			hash := sha256Hex(d.Content)
			chunks := splitChunks(content, d.Filename, d.Page, d.Section, req.ChunkSize, req.ChunkOverlap)
			results[idx] = ProcessDocResult{
				Filename:   d.Filename,
				Hash:       hash,
				Redactions: redactions,
				Chunks:     chunks,
			}
		}(i, doc)
	}
	wg.Wait()
	return ProcessResponse{Results: results}
}

func tokenize(text string) []string {
	raw := tokenRe.FindAllString(strings.ToLower(text), -1)
	out := make([]string, 0, len(raw))
	for _, t := range raw {
		if len(t) > 1 && !stopTokens[t] {
			out = append(out, t)
		}
	}
	return out
}

func scoreBM25(req BM25Request) []BM25Hit {
	qTokens := tokenize(req.Query)
	if len(qTokens) == 0 || len(req.Documents) == 0 {
		return []BM25Hit{}
	}

	limit := req.Limit
	if limit <= 0 {
		limit = 15
	}

	type docStat struct {
		id  string
		tf  map[string]int
		len int
	}
	stats := make([]docStat, len(req.Documents))
	df := make(map[string]int)
	totalLen := 0

	for i, d := range req.Documents {
		toks := tokenize(d.Content)
		tf := make(map[string]int)
		for _, tok := range toks {
			tf[tok]++
		}
		for term := range tf {
			df[term]++
		}
		totalLen += len(toks)
		stats[i] = docStat{id: d.ID, tf: tf, len: len(toks)}
	}

	avgDL := float64(totalLen) / float64(len(stats))
	if avgDL == 0 {
		avgDL = 1
	}

	const k1 = 1.5
	const b = 0.75
	N := float64(len(stats))

	uniqueQ := make(map[string]bool, len(qTokens))
	for _, qt := range qTokens {
		uniqueQ[qt] = true
	}

	var hits []BM25Hit
	for _, st := range stats {
		score := 0.0
		for term := range uniqueQ {
			freq := st.tf[term]
			if freq == 0 {
				continue
			}
			docFreq := float64(df[term])
			idf := math.Log((N-docFreq+0.5)/(docFreq+0.5) + 1.0)
			num := float64(freq) * (k1 + 1.0)
			den := float64(freq) + k1*(1.0-b+b*(float64(st.len)/avgDL))
			score += idf * (num / den)
		}
		if score > 0 {
			hits = append(hits, BM25Hit{ID: st.id, Score: score})
		}
	}

	sort.Slice(hits, func(i, j int) bool {
		if hits[i].Score == hits[j].Score {
			return hits[i].ID < hits[j].ID
		}
		return hits[i].Score > hits[j].Score
	})

	if len(hits) > limit {
		hits = hits[:limit]
	}
	return hits
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func newRouter() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{
			"status":  "ok",
			"service": "ragchat-go-worker",
			"runtime": runtime.Version(),
		})
	})

	mux.HandleFunc("POST /v1/process", func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 16<<20)
		var req ProcessRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
			return
		}
		if len(req.Documents) > 200 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "max 200 documents per batch"})
			return
		}
		writeJSON(w, http.StatusOK, processBatch(req))
	})

	mux.HandleFunc("POST /v1/bm25", func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 16<<20)
		var req BM25Request
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
			return
		}
		writeJSON(w, http.StatusOK, BM25Response{Hits: scoreBM25(req)})
	})
	return mux
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8090"
	}
	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           newRouter(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
	}
	log.Printf("[ragchat-worker] listening on :%s", port)
	log.Fatal(srv.ListenAndServe())
}
