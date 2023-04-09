FROM golang:latest

RUN mkdir /go/src/work
WORKDIR /go/src/work
EXPOSE 80
ADD . /go/src/work


CMD ["go","run","main.go"]
