FROM golang:1.23-alpine AS builder
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /worker .

FROM alpine:3.21
WORKDIR /app
RUN addgroup -S worker && adduser -S worker -G worker
COPY --from=builder /worker /app/worker
USER worker
EXPOSE 8090
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8090/health || exit 1
CMD ["/app/worker"]
