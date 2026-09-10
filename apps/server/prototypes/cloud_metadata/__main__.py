"""Run an offline two-device demonstration in temporary synthetic folders"""

from .harness import Pair
from .merge import heads


# Show disjoint reconciliation, conflict scope and recovery without any provider upload
def main() -> None:
    pair = Pair()
    try:
        pair.a.edit({"entity/bundle/title": "Amber title"})
        pair.b.edit({"entity/bundle/note": "Blue note"})
        pair.sync()
        assert not pair.a.view().conflicts
        assert pair.a.display()["entity/bundle/note"] == "Blue note"
        print("Both devices open: offline title + note edits combined")
        rejected = pair.a.edit({"entity/bundle/title": "Amber revision"})
        pair.b.edit({"entity/bundle/title": "Blue revision", "entity/bundle/rating": 8})
        pair.sync()
        assert set(pair.a.view().conflicts) == {"entity/bundle/title"}
        print("Concurrent title edits: both preserved; note and rating still combined")
        pair.a.resolve(
            {"entity/bundle/title": "Blue revision"}, heads(pair.a.events()), "demo-choice"
        )
        pair.sync()
        assert pair.a.view() == pair.b.view()
        assert not pair.b.view().conflicts
        assert pair.a.recover(rejected).values["entity/bundle/title"] == "Amber revision"
        print("Keep Blue title: both devices agree; complete Amber branch remains recoverable")
        print("Only disposable local files were used; no provider behavior was tested")
    finally:
        pair.close()


if __name__ == "__main__":
    main()
