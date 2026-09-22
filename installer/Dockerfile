# syntax=docker/dockerfile:1
#
# The installer, as an image: install.sh with the Docker CLI beside it, so that
# the one command to install or repair abs-butler is the same on Windows, macOS
# and Linux, and needs nothing on the machine but Docker.
#
#   docker run --rm -it -v /var/run/docker.sock:/var/run/docker.sock -v "${PWD}:/install" ghcr.io/cwpetrich/abs-butler-installer
#
# It is handed the Docker socket, which is root on the host -- for as long as
# the command runs, because somebody ran it, and never again. The abs-butler
# container it installs never gets the socket.
#
# Built from the repository root: docker build -f installer/Dockerfile .
FROM docker:cli

RUN apk add --no-cache curl

# The compose file travels with the script that wrote it, so an installer
# installs the release it came from rather than whatever is on main.
COPY install.sh docker-compose.yml /opt/abs-butler-installer/
COPY installer/entrypoint.sh /usr/local/bin/abs-butler-installer
RUN chmod +x /usr/local/bin/abs-butler-installer

ENV ABS_BUTLER_IN_CONTAINER=1
WORKDIR /install
ENTRYPOINT ["/usr/local/bin/abs-butler-installer"]
