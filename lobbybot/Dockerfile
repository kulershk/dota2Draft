FROM golang:1.25-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
COPY third_party ./third_party
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /lobbybot .

FROM alpine:3.19
RUN apk --no-cache add ca-certificates
COPY --from=builder /lobbybot /lobbybot
ENTRYPOINT ["/lobbybot"]
