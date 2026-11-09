package eu.monoplayer.driver.mixin;

import net.minecraft.client.Minecraft;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * Give the driver client its own window name. On Wayland the window title is
 * also the app_id/class Hyprland sees, so a workspace rule can target this
 * client without touching normal Minecraft windows.
 */
@Mixin(Minecraft.class)
public abstract class MinecraftTitleMixin {
    @Inject(method = "createTitle", at = @At("HEAD"), cancellable = true)
    private void monoplayer$customTitle(CallbackInfoReturnable<String> cir) {
        cir.setReturnValue(System.getProperty("gateb.window.title", "Monoplayer Gate B"));
    }
}
