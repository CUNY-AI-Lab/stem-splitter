"""Minimal EfficientAT MN10 architecture for the exact v0.0.1 checkpoint.

Derived from EfficientAT revision 7e30f2b under its MIT license. Network names
and module ordering intentionally match the upstream state dictionary exactly.
"""

from __future__ import annotations

import math
from functools import partial
from typing import Callable, Optional, Sequence

import torch
from torch import Tensor, nn
import torch.nn.functional as functional


def make_divisible(value: float, divisor: int, minimum: Optional[int] = None) -> int:
    minimum = divisor if minimum is None else minimum
    result = max(minimum, int(value + divisor / 2) // divisor * divisor)
    return result + divisor if result < 0.9 * value else result


def convolution_output(size: int, padding: int, dilation: int, kernel: int, stride: int) -> int:
    return math.floor((size + 2 * padding - dilation * (kernel - 1) - 1) / stride + 1)


class ConvNormActivation(nn.Sequential):
    def __init__(
        self,
        in_channels: int,
        out_channels: int,
        *,
        kernel_size: int = 3,
        stride: int = 1,
        dilation: int = 1,
        groups: int = 1,
        norm_layer: Optional[Callable[..., nn.Module]] = nn.BatchNorm2d,
        activation_layer: Optional[Callable[..., nn.Module]] = nn.ReLU,
    ) -> None:
        padding = (kernel_size - 1) // 2 * dilation
        layers: list[nn.Module] = [
            nn.Conv2d(
                in_channels,
                out_channels,
                kernel_size,
                stride,
                padding,
                dilation=dilation,
                groups=groups,
                bias=norm_layer is None,
            )
        ]
        if norm_layer is not None:
            layers.append(norm_layer(out_channels))
        if activation_layer is not None:
            layers.append(activation_layer())
        super().__init__(*layers)


class SqueezeExcitation(nn.Module):
    def __init__(self, input_dim: int, squeeze_dim: int, se_dim: int) -> None:
        super().__init__()
        self.fc1 = nn.Linear(input_dim, squeeze_dim)
        self.fc2 = nn.Linear(squeeze_dim, input_dim)
        if se_dim not in {1, 2, 3}:
            raise ValueError("EfficientAT squeeze dimension is invalid")
        self.se_dim = [value for value in (1, 2, 3) if value != se_dim]
        self.activation = nn.ReLU()
        self.scale_activation = nn.Sigmoid()

    def forward(self, value: Tensor) -> Tensor:
        scale = torch.mean(value, self.se_dim, keepdim=True)
        shape = scale.size()
        scale = self.fc2(self.activation(self.fc1(scale.squeeze())))
        return self.scale_activation(scale).view(shape) * value


class ConcurrentSEBlock(nn.Module):
    def __init__(self, channel_dim: int, frequency_dim: int, time_dim: int, config: dict) -> None:
        super().__init__()
        dimensions = [channel_dim, frequency_dim, time_dim]
        self.conc_se_layers = nn.ModuleList()
        for dimension in config["se_dims"]:
            input_dim = dimensions[dimension - 1]
            squeeze_dim = make_divisible(input_dim // config["se_r"], 8)
            self.conc_se_layers.append(SqueezeExcitation(input_dim, squeeze_dim, dimension))
        if config["se_agg"] != "max":
            raise ValueError("EfficientAT squeeze aggregation is not pinned")

    def forward(self, value: Tensor) -> Tensor:
        return torch.max(torch.stack([layer(value) for layer in self.conc_se_layers]), dim=0)[0]


class InvertedResidualConfig:
    def __init__(
        self,
        input_channels: int,
        kernel: int,
        expanded_channels: int,
        out_channels: int,
        use_se: bool,
        activation: str,
        stride: int,
        dilation: int,
        width_mult: float,
    ) -> None:
        self.input_channels = self.adjust_channels(input_channels, width_mult)
        self.kernel = kernel
        self.expanded_channels = self.adjust_channels(expanded_channels, width_mult)
        self.out_channels = self.adjust_channels(out_channels, width_mult)
        self.use_se = use_se
        self.use_hs = activation == "HS"
        self.stride = stride
        self.dilation = dilation
        self.f_dim = 0
        self.t_dim = 0

    @staticmethod
    def adjust_channels(channels: int, width_mult: float) -> int:
        return make_divisible(channels * width_mult, 8)

    def out_size(self, input_size: int) -> int:
        padding = (self.kernel - 1) // 2 * self.dilation
        return convolution_output(input_size, padding, self.dilation, self.kernel, self.stride)


class InvertedResidual(nn.Module):
    def __init__(
        self,
        config: InvertedResidualConfig,
        se_config: dict,
        norm_layer: Callable[..., nn.Module],
        depthwise_norm_layer: Callable[..., nn.Module],
    ) -> None:
        super().__init__()
        if config.stride not in {1, 2}:
            raise ValueError("EfficientAT residual stride is invalid")
        self.use_res_connect = (
            config.stride == 1 and config.input_channels == config.out_channels
        )
        layers: list[nn.Module] = []
        activation = nn.Hardswish if config.use_hs else nn.ReLU
        if config.expanded_channels != config.input_channels:
            layers.append(
                ConvNormActivation(
                    config.input_channels,
                    config.expanded_channels,
                    kernel_size=1,
                    norm_layer=norm_layer,
                    activation_layer=activation,
                )
            )
        stride = 1 if config.dilation > 1 else config.stride
        layers.append(
            ConvNormActivation(
                config.expanded_channels,
                config.expanded_channels,
                kernel_size=config.kernel,
                stride=stride,
                dilation=config.dilation,
                groups=config.expanded_channels,
                norm_layer=depthwise_norm_layer,
                activation_layer=activation,
            )
        )
        if config.use_se and se_config["se_dims"] is not None:
            layers.append(
                ConcurrentSEBlock(
                    config.expanded_channels,
                    config.f_dim,
                    config.t_dim,
                    se_config,
                )
            )
        layers.append(
            ConvNormActivation(
                config.expanded_channels,
                config.out_channels,
                kernel_size=1,
                norm_layer=norm_layer,
                activation_layer=None,
            )
        )
        self.block = nn.Sequential(*layers)
        self.out_channels = config.out_channels
        self._is_cn = config.stride > 1

    def forward(self, value: Tensor) -> Tensor:
        result = self.block(value)
        return result + value if self.use_res_connect else result


class MobileNetV3(nn.Module):
    def __init__(self, settings: Sequence[InvertedResidualConfig], last_channel: int) -> None:
        super().__init__()
        norm = partial(nn.BatchNorm2d, eps=0.001, momentum=0.01)
        layers: list[nn.Module] = [
            ConvNormActivation(
                1,
                settings[0].input_channels,
                kernel_size=3,
                stride=2,
                norm_layer=norm,
                activation_layer=nn.Hardswish,
            )
        ]
        frequency_dim, time_dim = 128, 1000
        frequency_dim = convolution_output(frequency_dim, 1, 1, 3, 2)
        time_dim = convolution_output(time_dim, 1, 1, 3, 2)
        se_config = {"se_dims": [1], "se_agg": "max", "se_r": 4}
        for config in settings:
            frequency_dim = config.out_size(frequency_dim)
            time_dim = config.out_size(time_dim)
            config.f_dim, config.t_dim = frequency_dim, time_dim
            layers.append(InvertedResidual(config, se_config, norm, norm))
        last_input = settings[-1].out_channels
        layers.append(
            ConvNormActivation(
                last_input,
                6 * last_input,
                kernel_size=1,
                norm_layer=norm,
                activation_layer=nn.Hardswish,
            )
        )
        self.features = nn.Sequential(*layers)
        self.head_type = "mlp"
        self.classifier = nn.Sequential(
            nn.AdaptiveAvgPool2d(1),
            nn.Flatten(start_dim=1),
            nn.Linear(6 * last_input, last_channel),
            nn.Hardswish(inplace=True),
            nn.Dropout(p=0.2, inplace=True),
            nn.Linear(last_channel, 527),
        )

    def forward(self, value: Tensor) -> tuple[Tensor, Tensor]:
        value = self.features(value)
        features = functional.adaptive_avg_pool2d(value, (1, 1)).squeeze()
        return self.classifier(value).squeeze(), features


def build_mn10_audioset() -> MobileNetV3:
    block = partial(InvertedResidualConfig, width_mult=1.0)
    settings = [
        block(16, 3, 16, 16, False, "RE", 1, 1),
        block(16, 3, 64, 24, False, "RE", 2, 1),
        block(24, 3, 72, 24, False, "RE", 1, 1),
        block(24, 5, 72, 40, True, "RE", 2, 1),
        block(40, 5, 120, 40, True, "RE", 1, 1),
        block(40, 5, 120, 40, True, "RE", 1, 1),
        block(40, 3, 240, 80, False, "HS", 2, 1),
        block(80, 3, 200, 80, False, "HS", 1, 1),
        block(80, 3, 184, 80, False, "HS", 1, 1),
        block(80, 3, 184, 80, False, "HS", 1, 1),
        block(80, 3, 480, 112, True, "HS", 1, 1),
        block(112, 3, 672, 112, True, "HS", 1, 1),
        block(112, 5, 672, 160, True, "HS", 2, 1),
        block(160, 5, 960, 160, True, "HS", 1, 1),
        block(160, 5, 960, 160, True, "HS", 1, 1),
    ]
    return MobileNetV3(settings, InvertedResidualConfig.adjust_channels(1280, 1.0))
