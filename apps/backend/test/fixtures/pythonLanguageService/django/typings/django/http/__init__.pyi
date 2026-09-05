from typing import Mapping


class HttpRequest:
    method: str


class JsonResponse:
    status_code: int

    def __init__(self, data: Mapping[str, object]) -> None: ...
