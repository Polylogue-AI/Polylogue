import pytest


def pytest_addoption(parser):
    parser.addoption("--run-docker", action="store_true", help="运行需要本地 Docker 镜像的集成测试")


def pytest_collection_modifyitems(config, items):
    if not config.getoption("--run-docker"):
        skip = pytest.mark.skip(reason="使用 --run-docker 启用 Docker 集成测试")
        for item in items:
            if item.get_closest_marker("docker"):
                item.add_marker(skip)
